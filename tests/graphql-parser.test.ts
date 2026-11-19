import test from 'node:test';
import assert from 'node:assert';
import { parse } from '../graphql-parser.ts';

test('GraphQL Parser - ViewerLogin', () => {
  const query = `query ViewerLogin {
    viewer {
      login
    }
  }`;
  const doc = parse(query);
  assert.strictEqual(doc.kind, 'Document');
  assert.strictEqual(doc.definitions.length, 1);
  const op = doc.definitions[0];
  assert.strictEqual(op.kind, 'OperationDefinition');
  if (op.kind === 'OperationDefinition') {
    assert.strictEqual(op.operation, 'query');
    assert.strictEqual(op.name, 'ViewerLogin');
    assert.strictEqual(op.selectionSet.selections.length, 1);
    const viewerField = op.selectionSet.selections[0];
    assert.strictEqual(viewerField.kind, 'Field');
    if (viewerField.kind === 'Field') {
      assert.strictEqual(viewerField.name, 'viewer');
      assert.ok(viewerField.selectionSet);
      assert.strictEqual(viewerField.selectionSet.selections.length, 1);
      const loginField = viewerField.selectionSet.selections[0];
      assert.strictEqual(loginField.kind, 'Field');
      if (loginField.kind === 'Field') {
        assert.strictEqual(loginField.name, 'login');
      }
    }
  }
});

test('GraphQL Parser - RepositoryFields and Variables', () => {
  const query = `query RepositoryFields($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
      databaseId
      name
      owner {
        login
      }
      defaultBranchRef {
        name
      }
      viewerPermission
      hasIssuesEnabled
    }
  }`;
  const doc = parse(query);
  const op = doc.definitions[0] as any;
  assert.strictEqual(op.name, 'RepositoryFields');
  assert.strictEqual(op.variableDefinitions.length, 2);
  assert.strictEqual(op.variableDefinitions[0].variable.name, 'owner');
  assert.strictEqual(op.variableDefinitions[0].type.kind, 'NonNullType');

  const repoField = op.selectionSet.selections[0];
  assert.strictEqual(repoField.name, 'repository');
  assert.strictEqual(repoField.arguments.length, 2);
  assert.strictEqual(repoField.arguments[0].name, 'owner');
  assert.strictEqual(repoField.arguments[0].value.kind, 'Variable');
  assert.strictEqual(repoField.arguments[0].value.name, 'owner');
});

test('GraphQL Parser - Aliases and Introspection', () => {
  const query = `query Issue_fields {
    Issue: __type(name: "Issue") {
      fields(includeDeprecated: true) {
        name
      }
    }
  }`;
  const doc = parse(query);
  const op = doc.definitions[0] as any;
  const typeField = op.selectionSet.selections[0];
  assert.strictEqual(typeField.alias, 'Issue');
  assert.strictEqual(typeField.name, '__type');
  assert.strictEqual(typeField.arguments[0].name, 'name');
  assert.strictEqual(typeField.arguments[0].value.value, 'Issue');

  const fieldsField = typeField.selectionSet.selections[0];
  assert.strictEqual(fieldsField.name, 'fields');
  assert.strictEqual(fieldsField.arguments[0].name, 'includeDeprecated');
  assert.strictEqual(fieldsField.arguments[0].value.value, true);
});

test('GraphQL Parser - Complex Arguments (Lists and Objects)', () => {
  const query = `query OpenIssues($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
        nodes {
          number
          title
        }
      }
    }
  }`;
  const doc = parse(query);
  const op = doc.definitions[0] as any;
  const repoField = op.selectionSet.selections[0];
  const issuesField = repoField.selectionSet.selections[0];
  const statesArg = issuesField.arguments.find((a: any) => a.name === 'states');
  assert.strictEqual(statesArg.value.kind, 'ListValue');
  assert.strictEqual(statesArg.value.values[0].value, 'OPEN');

  const orderArg = issuesField.arguments.find((a: any) => a.name === 'orderBy');
  assert.strictEqual(orderArg.value.kind, 'ObjectValue');
  assert.strictEqual(orderArg.value.fields.length, 2);
  assert.strictEqual(orderArg.value.fields[0].name, 'field');
  assert.strictEqual(orderArg.value.fields[0].value.value, 'CREATED_AT');
});

test('GraphQL Parser - Mutations and Fragments', () => {
  const query = `
    fragment RepoFields on Repository {
      name
      nameWithOwner
    }
    mutation AddComment($input: AddCommentInput!) {
      addComment(input: $input) {
        commentEdge {
          node {
            id
            body
          }
        }
      }
    }
    query NodeRepo($id: ID!) {
      node(id: $id) {
        id
        ...RepoFields
        ... on Repository {
          databaseId
        }
      }
    }
  `;
  const doc = parse(query);
  assert.strictEqual(doc.definitions.length, 3);
  assert.strictEqual(doc.definitions[0].kind, 'FragmentDefinition');
  assert.strictEqual(doc.definitions[1].kind, 'OperationDefinition');
  assert.strictEqual(doc.definitions[2].kind, 'OperationDefinition');

  const nodeOp = doc.definitions[2] as any;
  const nodeField = nodeOp.selectionSet.selections[0];
  const spread = nodeField.selectionSet.selections[1];
  assert.strictEqual(spread.kind, 'FragmentSpread');
  assert.strictEqual(spread.name, 'RepoFields');

  const inlineFrag = nodeField.selectionSet.selections[2];
  assert.strictEqual(inlineFrag.kind, 'InlineFragment');
  assert.strictEqual(inlineFrag.typeCondition, 'Repository');
});
