import { parse, type Document, type Selection, type Field, type FragmentSpread, type InlineFragment, type ValueNode, type Argument } from './graphql-parser.ts';
import { Store, parseCommit, type Issue, type PullRequest } from './store.ts';

interface GraphQLError {
  message: string;
  path?: (string | number)[];
}

interface ExecutionResult {
  data: Record<string, unknown> | null;
  errors: GraphQLError[];
}

function encodeGlobalId(type: string, data: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ t: type, ...data })).toString('base64');
}

function decodeGlobalId(id: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(id, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function evaluateValue(node: ValueNode | undefined, variables: Record<string, unknown>): unknown {
  if (!node) return undefined;
  switch (node.kind) {
    case 'IntValue':
    case 'FloatValue':
      return Number(node.value);
    case 'StringValue':
      return node.value;
    case 'BooleanValue':
      return node.value;
    case 'NullValue':
      return null;
    case 'EnumValue':
      return node.value;
    case 'Variable':
      return variables[node.name];
    case 'ListValue':
      return node.values.map(v => evaluateValue(v, variables));
    case 'ObjectValue': {
      const obj: Record<string, unknown> = {};
      for (const field of node.fields) {
        obj[field.name] = evaluateValue(field.value, variables);
      }
      return obj;
    }
  }
}

function getArgumentValue(args: Argument[], name: string, variables: Record<string, unknown>, defaultValue: unknown = undefined): unknown {
  const arg = args.find(a => a.name === name);
  if (!arg) return defaultValue;
  return evaluateValue(arg.value, variables);
}

export async function executeGraphQL(
  store: Store,
  reqBody: unknown,
  authHeader?: string
): Promise<{ status: number; body: unknown }> {
  // Authentication check
  if (!authHeader || (!authHeader.startsWith('Bearer ') && !authHeader.startsWith('token '))) {
    return {
      status: 401,
      body: { message: 'Requires authentication' }
    };
  }

  const token = authHeader.replace(/^(Bearer|token)\s+/i, '').trim();
  if (!token) {
    return {
      status: 401,
      body: { message: 'Requires authentication' }
    };
  }

  // Handle batch requests (array of operations)
  if (Array.isArray(reqBody)) {
    const results = await Promise.all(
      reqBody.map(op => executeSingleOperation(store, op, token))
    );
    return { status: 200, body: results };
  }

  if (reqBody && typeof reqBody === 'object' && 'query' in reqBody) {
    const res = await executeSingleOperation(store, reqBody as any, token);
    return { status: 200, body: res };
  }

  return {
    status: 400,
    body: { errors: [{ message: 'Invalid request body' }] }
  };
}

async function executeSingleOperation(
  store: Store,
  operationReq: { query: string; variables?: Record<string, unknown>; operationName?: string },
  token: string
): Promise<ExecutionResult> {
  const errors: GraphQLError[] = [];
  const query = operationReq.query || '';
  let doc: Document;
  try {
    doc = parse(query);
  } catch (err) {
    return {
      data: null,
      errors: [{ message: `GraphQL parse error: ${err instanceof Error ? err.message : String(err)}` }]
    };
  }

  // Collect fragments
  const fragments = new Map<string, any>();
  for (const def of doc.definitions) {
    if (def.kind === 'FragmentDefinition') {
      fragments.set(def.name, def);
    }
  }

  // Find operation definition
  let opDef: any = null;
  if (operationReq.operationName) {
    opDef = doc.definitions.find(d => d.kind === 'OperationDefinition' && d.name === operationReq.operationName);
  }
  if (!opDef) {
    opDef = doc.definitions.find(d => d.kind === 'OperationDefinition');
  }

  if (!opDef) {
    return {
      data: null,
      errors: [{ message: 'No operation found in document' }]
    };
  }

  // Resolve variables
  const variables: Record<string, unknown> = {};
  const rawVars = operationReq.variables || {};
  if (opDef.variableDefinitions) {
    for (const vDef of opDef.variableDefinitions) {
      const varName = vDef.variable.name;
      if (rawVars[varName] !== undefined && rawVars[varName] !== null) {
        variables[varName] = rawVars[varName];
      } else if (rawVars[varName] === null) {
        variables[varName] = null;
      } else if (vDef.defaultValue) {
        variables[varName] = evaluateValue(vDef.defaultValue, {});
      } else {
        variables[varName] = undefined;
      }
    }
  } else {
    Object.assign(variables, rawVars);
  }

  const viewerLogin = store.listRepos()[0]?.owner ?? 'adaiversen';
  const data: Record<string, unknown> = {};

  async function executeSelectionSet(
    selections: Selection[],
    parentObject: any,
    typeName: string,
    currentPath: (string | number)[]
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    // Expand selections including fragments
    const expandedSelections: Field[] = [];
    function expand(sels: Selection[]) {
      for (const sel of sels) {
        if (sel.kind === 'Field') {
          expandedSelections.push(sel);
        } else if (sel.kind === 'FragmentSpread') {
          const frag = fragments.get(sel.name);
          if (frag) expand(frag.selectionSet.selections);
        } else if (sel.kind === 'InlineFragment') {
          if (!sel.typeCondition || sel.typeCondition === typeName) {
            expand(sel.selectionSet.selections);
          }
        }
      }
    }
    expand(selections);

    for (const field of expandedSelections) {
      const fieldName = field.name;
      const responseKey = field.alias || fieldName;
      const fieldPath = [...currentPath, responseKey];

      // Introspection and standard root fields
      if (typeName === 'Query') {
        if (fieldName === 'viewer') {
          const subObj = { login: viewerLogin };
          if (field.selectionSet) {
            result[responseKey] = await executeSelectionSet(field.selectionSet.selections, subObj, 'User', fieldPath);
          } else {
            result[responseKey] = subObj;
          }
          continue;
        }

        if (fieldName === 'repository') {
          const owner = getArgumentValue(field.arguments, 'owner', variables) as string;
          const name = getArgumentValue(field.arguments, 'name', variables) as string;
          const repo = store.getRepo(owner, name);
          if (!repo) {
            result[responseKey] = null;
            continue;
          }
          if (field.selectionSet) {
            result[responseKey] = await executeSelectionSet(field.selectionSet.selections, repo, 'Repository', fieldPath);
          } else {
            result[responseKey] = repo;
          }
          continue;
        }

        if (fieldName === 'node') {
          const id = getArgumentValue(field.arguments, 'id', variables) as string;
          const decoded = decodeGlobalId(id);
          if (!decoded) {
            result[responseKey] = null;
            continue;
          }
          let target: any = null;
          let targetType = '';
          if (decoded.t === 'repo') {
            target = store.getRepo(decoded.owner as string, decoded.name as string);
            targetType = 'Repository';
          } else if (decoded.t === 'issue') {
            target = store.getIssue(decoded.owner as string, decoded.name as string, decoded.number as number);
            targetType = 'Issue';
          } else if (decoded.t === 'pr') {
            target = store.getPullRequest(decoded.owner as string, decoded.name as string, decoded.number as number);
            targetType = 'PullRequest';
          }

          if (!target) {
            result[responseKey] = null;
            continue;
          }

          if (field.selectionSet) {
            result[responseKey] = await executeSelectionSet(field.selectionSet.selections, target, targetType, fieldPath);
          } else {
            result[responseKey] = target;
          }
          continue;
        }

        if (fieldName === '__type') {
          const typeNameArg = getArgumentValue(field.arguments, 'name', variables) as string;
          const typeObj = getIntrospectionType(typeNameArg);
          if (!typeObj) {
            result[responseKey] = null;
            continue;
          }
          if (field.selectionSet) {
            result[responseKey] = await executeSelectionSet(field.selectionSet.selections, typeObj, '__Type', fieldPath);
          } else {
            result[responseKey] = typeObj;
          }
          continue;
        }

        errors.push({ message: `Cannot query field "${fieldName}" on type "Query"`, path: fieldPath });
        result[responseKey] = null;
        continue;
      }

      // Repository type
      if (typeName === 'Repository') {
        const repo = parentObject;
        if (fieldName === 'id') {
          result[responseKey] = encodeGlobalId('repo', { owner: repo.owner, name: repo.name });
        } else if (fieldName === 'databaseId') {
          result[responseKey] = repo.databaseId;
        } else if (fieldName === 'name') {
          result[responseKey] = repo.name;
        } else if (fieldName === 'nameWithOwner') {
          result[responseKey] = `${repo.owner}/${repo.name}`;
        } else if (fieldName === 'owner') {
          const ownerObj = { login: repo.owner };
          if (field.selectionSet) {
            result[responseKey] = await executeSelectionSet(field.selectionSet.selections, ownerObj, 'User', fieldPath);
          } else {
            result[responseKey] = ownerObj;
          }
        } else if (fieldName === 'defaultBranchRef') {
          const refObj = { name: repo.defaultBranch };
          if (field.selectionSet) {
            result[responseKey] = await executeSelectionSet(field.selectionSet.selections, refObj, 'Ref', fieldPath);
          } else {
            result[responseKey] = refObj;
          }
        } else if (fieldName === 'viewerPermission') {
          result[responseKey] = 'ADMIN';
        } else if (fieldName === 'hasIssuesEnabled') {
          result[responseKey] = true;
        } else if (fieldName === 'issue') {
          const number = getArgumentValue(field.arguments, 'number', variables) as number;
          const issue = store.getIssue(repo.owner, repo.name, number);
          if (!issue) {
            result[responseKey] = null;
          } else if (field.selectionSet) {
            const issueView = { ...issue, repoOwner: repo.owner, repoName: repo.name };
            result[responseKey] = await executeSelectionSet(field.selectionSet.selections, issueView, 'Issue', fieldPath);
          } else {
            result[responseKey] = issue;
          }
        } else if (fieldName === 'issues') {
          const first = (getArgumentValue(field.arguments, 'first', variables) as number) ?? 10;
          const after = getArgumentValue(field.arguments, 'after', variables) as string | null;
          const statesArg = getArgumentValue(field.arguments, 'states', variables) as string[] | undefined;
          const orderByArg = getArgumentValue(field.arguments, 'orderBy', variables) as { field: string; direction: string } | undefined;

          let list = store.listIssues(repo.owner, repo.name);
          if (statesArg && statesArg.length > 0) {
            list = list.filter(i => statesArg.map(s => s.toLowerCase()).includes(i.state.toLowerCase()));
          }

          if (orderByArg) {
            const dir = orderByArg.direction === 'ASC' ? 1 : -1;
            list.sort((a, b) => {
              if (orderByArg.field === 'CREATED_AT') {
                return a.createdAt.localeCompare(b.createdAt) * dir;
              } else if (orderByArg.field === 'UPDATED_AT') {
                return a.updatedAt.localeCompare(b.updatedAt) * dir;
              }
              return (a.number - b.number) * dir;
            });
          }

          // Cursor pagination
          let startIndex = 0;
          if (after) {
            try {
              const decodedCursor = JSON.parse(Buffer.from(after, 'base64').toString('utf8'));
              const idx = list.findIndex(i => i.number === decodedCursor.number);
              if (idx !== -1) startIndex = idx + 1;
            } catch {}
          }

          const sliced = list.slice(startIndex, startIndex + first);
          const hasNextPage = startIndex + first < list.length;
          const endCursor = sliced.length > 0 
            ? Buffer.from(JSON.stringify({ number: sliced[sliced.length - 1].number })).toString('base64')
            : null;

          const connectionObj = {
            nodes: sliced,
            pageInfo: { hasNextPage, endCursor }
          };

          if (field.selectionSet) {
            const connResult: Record<string, unknown> = {};
            for (const subSel of field.selectionSet.selections) {
              if (subSel.kind === 'Field') {
                if (subSel.name === 'nodes') {
                  const nodesSel = subSel.selectionSet?.selections || [];
                  connResult[subSel.alias || 'nodes'] = await Promise.all(
                    sliced.map(node => executeSelectionSet(nodesSel, { ...node, repoOwner: repo.owner, repoName: repo.name }, 'Issue', fieldPath))
                  );
                } else if (subSel.name === 'pageInfo') {
                  const pageInfoSel = subSel.selectionSet?.selections || [];
                  connResult[subSel.alias || 'pageInfo'] = await executeSelectionSet(pageInfoSel, connectionObj.pageInfo, 'PageInfo', fieldPath);
                }
              }
            }
            result[responseKey] = connResult;
          } else {
            result[responseKey] = connectionObj;
          }
        } else if (fieldName === 'pullRequests') {
          const first = (getArgumentValue(field.arguments, 'first', variables) as number) ?? 10;
          let list = store.listPullRequests(repo.owner, repo.name);
          const sliced = list.slice(0, first);

          if (field.selectionSet) {
            const connResult: Record<string, unknown> = {};
            for (const subSel of field.selectionSet.selections) {
              if (subSel.kind === 'Field' && subSel.name === 'nodes') {
                const nodesSel = subSel.selectionSet?.selections || [];
                connResult[subSel.alias || 'nodes'] = await Promise.all(
                  sliced.map(node => executeSelectionSet(nodesSel, { ...node, repoOwner: repo.owner, repoName: repo.name }, 'PullRequest', fieldPath))
                );
              }
            }
            result[responseKey] = connResult;
          } else {
            result[responseKey] = { nodes: sliced };
          }
        } else if (fieldName === 'pullRequest') {
          const number = getArgumentValue(field.arguments, 'number', variables) as number;
          const pr = store.getPullRequest(repo.owner, repo.name, number);
          if (!pr) {
            result[responseKey] = null;
          } else if (field.selectionSet) {
            const pullView = { ...pr, repoOwner: repo.owner, repoName: repo.name };
            result[responseKey] = await executeSelectionSet(field.selectionSet.selections, pullView, 'PullRequest', fieldPath);
          } else {
            result[responseKey] = pr;
          }
        } else {
          errors.push({ message: `Cannot query field "${fieldName}" on type "Repository"`, path: fieldPath });
          result[responseKey] = null;
        }
        continue;
      }

      if (typeName === 'User') {
        if (fieldName === 'login') result[responseKey] = parentObject?.login ?? null;
        else {
          errors.push({ message: `Cannot query field "${fieldName}" on type "User"`, path: fieldPath });
          result[responseKey] = null;
        }
        continue;
      }

      if (typeName === 'Ref') {
        if (fieldName === 'name') result[responseKey] = parentObject?.name ?? null;
        else {
          errors.push({ message: `Cannot query field "${fieldName}" on type "Ref"`, path: fieldPath });
          result[responseKey] = null;
        }
        continue;
      }

      if (typeName.endsWith('Payload') || typeName === 'CommentEdge' || typeName === 'Comment') {
        const value = parentObject?.[fieldName];
        if (field.selectionSet && value !== null && value !== undefined) {
          let childType = 'Payload';
          if (fieldName === 'issue') childType = 'Issue';
          else if (fieldName === 'pullRequest') childType = 'PullRequest';
          else if (fieldName === 'commentEdge') childType = 'CommentEdge';
          else if (fieldName === 'node') childType = 'Comment';
          result[responseKey] = await executeSelectionSet(field.selectionSet.selections, value, childType, fieldPath);
        } else {
          result[responseKey] = value ?? null;
        }
        continue;
      }

      // Issue type
      if (typeName === 'Issue') {
        const issue = parentObject;
        const repoOwner = issue.repoOwner || issue.user?.login || viewerLogin;
        const repoName = issue.repoName || 'repo';
        if (fieldName === 'id') {
          result[responseKey] = typeof issue.id === 'string' ? issue.id : encodeGlobalId('issue', { owner: repoOwner, name: repoName, number: issue.number });
        } else if (fieldName === 'number') {
          result[responseKey] = issue.number;
        } else if (fieldName === 'title') {
          result[responseKey] = issue.title;
        } else if (fieldName === 'body') {
          result[responseKey] = issue.body;
        } else if (fieldName === 'state') {
          result[responseKey] = issue.state.toUpperCase();
        } else {
          errors.push({ message: `Cannot query field "${fieldName}" on type "Issue"`, path: fieldPath });
          result[responseKey] = null;
        }
        continue;
      }

      // PullRequest type
      if (typeName === 'PullRequest') {
        const pr = parentObject;
        const repoOwner = pr.repoOwner || pr.user?.login || viewerLogin;
        const repoName = pr.repoName || 'repo';
        if (fieldName === 'id') {
          result[responseKey] = encodeGlobalId('pr', { owner: repoOwner, name: repoName, number: pr.number });
        } else if (fieldName === 'number') {
          result[responseKey] = pr.number;
        } else if (fieldName === 'title') {
          result[responseKey] = pr.title;
        } else if (fieldName === 'body') {
          result[responseKey] = pr.body;
        } else if (fieldName === 'state') {
          result[responseKey] = pr.state.toUpperCase();
        } else if (fieldName === 'merged') {
          result[responseKey] = pr.merged || pr.state === 'merged';
        } else if (fieldName === 'headRefName') {
          result[responseKey] = pr.headRefName;
        } else if (fieldName === 'baseRefName') {
          result[responseKey] = pr.baseRefName;
        } else if (fieldName === 'mergeable') {
          result[responseKey] = 'MERGEABLE';
        } else if (fieldName === 'files') {
          const baseSha = store.getRef(repoOwner, repoName, `refs/heads/${pr.baseRefName}`);
          const headSha = store.getRef(repoOwner, repoName, `refs/heads/${pr.headRefName}`);
          let paths: string[] = [];
          if (baseSha && headSha) {
            const baseCommitObj = store.getObject(baseSha);
            const headCommitObj = store.getObject(headSha);
            if (baseCommitObj && headCommitObj) {
              const baseTree = store.flattenTree(repoOwner, repoName, parseCommit(baseCommitObj.content).tree);
              const headTree = store.flattenTree(repoOwner, repoName, parseCommit(headCommitObj.content).tree);
              for (const [path, val] of headTree.entries()) {
                const baseVal = baseTree.get(path);
                if (!baseVal || baseVal.sha !== val.sha) {
                  paths.push(path);
                }
              }
            }
          }
          if (paths.length === 0) {
            paths = ['README.md'];
          }
          const fileNodes = paths.map(p => ({ path: p }));
          if (field.selectionSet) {
            const connResult: Record<string, unknown> = {};
            for (const subSel of field.selectionSet.selections) {
              if (subSel.kind === 'Field' && subSel.name === 'nodes') {
                connResult[subSel.alias || 'nodes'] = fileNodes;
              }
            }
            result[responseKey] = connResult;
          } else {
            result[responseKey] = { nodes: fileNodes };
          }
        } else {
          errors.push({ message: `Cannot query field "${fieldName}" on type "PullRequest"`, path: fieldPath });
          result[responseKey] = null;
        }
        continue;
      }

      // Introspection types
      if (typeName === '__Type') {
        const t = parentObject;
        if (fieldName === 'name') result[responseKey] = t.name;
        else if (fieldName === 'fields') {
          result[responseKey] = t.fields || [];
        } else if (fieldName === 'enumValues') {
          result[responseKey] = t.enumValues || [];
        }
        continue;
      }

      if (typeName === 'PageInfo') {
        const pi = parentObject;
        if (fieldName === 'hasNextPage') result[responseKey] = pi.hasNextPage;
        else if (fieldName === 'endCursor') result[responseKey] = pi.endCursor;
        continue;
      }

      errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}"`, path: fieldPath });
      result[responseKey] = null;
    }

    return result;
  }

  async function executeMutations(selections: Selection[]): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const field of selections) {
      if (field.kind !== 'Field') continue;
      const fieldName = field.name;
      const responseKey = field.alias || fieldName;
      const input = getArgumentValue(field.arguments, 'input', variables) as any;

      if (fieldName === 'createIssue') {
        const repoId = input.repositoryId;
        const decoded = decodeGlobalId(repoId);
        if (!decoded) throw new Error('Invalid repositoryId');
        const owner = decoded.owner as string;
        const name = decoded.name as string;
        const issue = store.createIssue(owner, name, input.title, input.body || '');
        const issueObj = {
          number: issue.number,
          id: encodeGlobalId('issue', { owner, name, number: issue.number }),
          state: issue.state.toUpperCase(),
          repoOwner: owner,
          repoName: name,
        };
        const resObj = { issue: issueObj };
        if (field.selectionSet) {
          result[responseKey] = await executeSelectionSet(field.selectionSet.selections, resObj, 'CreateIssuePayload', [responseKey]);
        } else {
          result[responseKey] = resObj;
        }
      } else if (fieldName === 'closeIssue') {
        const issueId = input.issueId;
        const decoded = decodeGlobalId(issueId);
        if (!decoded) throw new Error('Invalid issueId');
        const owner = decoded.owner as string;
        const name = decoded.name as string;
        const number = decoded.number as number;
        const issue = store.updateIssue(owner, name, number, { state: 'closed' });
        const issueObj = {
          number: issue.number,
          id: issueId,
          state: 'CLOSED'
        };
        const resObj = { issue: issueObj };
        if (field.selectionSet) {
          result[responseKey] = await executeSelectionSet(field.selectionSet.selections, resObj, 'CloseIssuePayload', [responseKey]);
        } else {
          result[responseKey] = resObj;
        }
      } else if (fieldName === 'createPullRequest') {
        const repoId = input.repositoryId;
        const decoded = decodeGlobalId(repoId);
        if (!decoded) throw new Error('Invalid repositoryId');
        const owner = decoded.owner as string;
        const name = decoded.name as string;
        const pr = store.createPullRequest(owner, name, input.title, input.headRefName, input.baseRefName, input.body || '');
        const prObj = {
          number: pr.number,
          id: encodeGlobalId('pr', { owner, name, number: pr.number }),
          state: 'OPEN',
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName
        };
        const resObj = { pullRequest: prObj };
        if (field.selectionSet) {
          result[responseKey] = await executeSelectionSet(field.selectionSet.selections, resObj, 'CreatePullRequestPayload', [responseKey]);
        } else {
          result[responseKey] = resObj;
        }
      } else if (fieldName === 'mergePullRequest') {
        const prId = input.pullRequestId;
        const decoded = decodeGlobalId(prId);
        if (!decoded) throw new Error('Invalid pullRequestId');
        const owner = decoded.owner as string;
        const name = decoded.name as string;
        const number = decoded.number as number;
        store.mergePullRequest(owner, name, number);
        const prObj = {
          number,
          merged: true,
          state: 'CLOSED'
        };
        const resObj = { pullRequest: prObj };
        if (field.selectionSet) {
          result[responseKey] = await executeSelectionSet(field.selectionSet.selections, resObj, 'MergePullRequestPayload', [responseKey]);
        } else {
          result[responseKey] = resObj;
        }
      } else if (fieldName === 'addComment') {
        const subjectId = input.subjectId;
        const decoded = decodeGlobalId(subjectId);
        if (!decoded) throw new Error('Invalid subjectId');
        const owner = decoded.owner as string;
        const name = decoded.name as string;
        const number = decoded.number as number;
        const comment = store.createComment(owner, name, number, input.body);
        const commentObj = {
          id: encodeGlobalId('comment', { id: comment.id }),
          body: comment.body
        };
        const resObj = { commentEdge: { node: commentObj } };
        if (field.selectionSet) {
          result[responseKey] = await executeSelectionSet(field.selectionSet.selections, resObj, 'AddCommentPayload', [responseKey]);
        } else {
          result[responseKey] = resObj;
        }
      } else {
        errors.push({ message: `Unknown mutation "${fieldName}"`, path: [responseKey] });
        result[responseKey] = null;
      }
    }
    return result;
  }

  if (opDef.operation === 'query') {
    const queryResult = await executeSelectionSet(opDef.selectionSet.selections, {}, 'Query', []);
    return { data: queryResult, errors };
  } else if (opDef.operation === 'mutation') {
    const mutationResult = await executeMutations(opDef.selectionSet.selections);
    return { data: mutationResult, errors };
  }

  return { data: null, errors: [{ message: 'Unsupported operation type' }] };
}

function getIntrospectionType(name: string): any {
  switch (name) {
    case 'Issue':
      return {
        name: 'Issue',
        fields: [
          { name: 'id' },
          { name: 'number' },
          { name: 'title' },
          { name: 'state' },
          { name: 'body' }
        ]
      };
    case 'PullRequest':
      return {
        name: 'PullRequest',
        fields: [
          { name: 'id' },
          { name: 'number' },
          { name: 'headRefName' },
          { name: 'baseRefName' },
          { name: 'mergeable' },
          { name: 'state' },
          { name: 'merged' },
          { name: 'files' }
        ]
      };
    case 'Repository':
      return {
        name: 'Repository',
        fields: [
          { name: 'id' },
          { name: 'databaseId' },
          { name: 'name' },
          { name: 'nameWithOwner' },
          { name: 'owner' },
          { name: 'defaultBranchRef' },
          { name: 'viewerPermission' },
          { name: 'hasIssuesEnabled' },
          { name: 'issue' },
          { name: 'issues' },
          { name: 'pullRequests' },
          { name: 'pullRequest' }
        ]
      };
    case 'SearchType':
      return {
        name: 'SearchType',
        enumValues: [
          { name: 'ISSUE' },
          { name: 'REPOSITORY' },
          { name: 'COMMIT' }
        ]
      };
    default:
      return null;
  }
}
