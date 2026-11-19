export type OperationType = 'query' | 'mutation' | 'subscription';

export interface Document {
  kind: 'Document';
  definitions: Definition[];
}

export type Definition = OperationDefinition | FragmentDefinition;

export interface OperationDefinition {
  kind: 'OperationDefinition';
  operation: OperationType;
  name?: string;
  variableDefinitions: VariableDefinition[];
  directives: Directive[];
  selectionSet: SelectionSet;
}

export interface FragmentDefinition {
  kind: 'FragmentDefinition';
  name: string;
  typeCondition: string;
  directives: Directive[];
  selectionSet: SelectionSet;
}

export interface VariableDefinition {
  kind: 'VariableDefinition';
  variable: Variable;
  type: TypeNode;
  defaultValue?: ValueNode;
}

export interface Variable {
  kind: 'Variable';
  name: string;
}

export type TypeNode = NamedTypeNode | ListTypeNode | NonNullTypeNode;

export interface NamedTypeNode {
  kind: 'NamedType';
  name: string;
}

export interface ListTypeNode {
  kind: 'ListType';
  type: TypeNode;
}

export interface NonNullTypeNode {
  kind: 'NonNullType';
  type: NamedTypeNode | ListTypeNode;
}

export interface SelectionSet {
  kind: 'SelectionSet';
  selections: Selection[];
}

export type Selection = Field | FragmentSpread | InlineFragment;

export interface Field {
  kind: 'Field';
  alias?: string;
  name: string;
  arguments: Argument[];
  directives: Directive[];
  selectionSet?: SelectionSet;
}

export interface FragmentSpread {
  kind: 'FragmentSpread';
  name: string;
  directives: Directive[];
}

export interface InlineFragment {
  kind: 'InlineFragment';
  typeCondition?: string;
  directives: Directive[];
  selectionSet: SelectionSet;
}

export interface Argument {
  kind: 'Argument';
  name: string;
  value: ValueNode;
}

export interface Directive {
  kind: 'Directive';
  name: string;
  arguments: Argument[];
}

export type ValueNode =
  | IntValueNode
  | FloatValueNode
  | StringValueNode
  | BooleanValueNode
  | NullValueNode
  | EnumValueNode
  | ListValueNode
  | ObjectValueNode
  | Variable;

export interface IntValueNode {
  kind: 'IntValue';
  value: string;
}

export interface FloatValueNode {
  kind: 'FloatValue';
  value: string;
}

export interface StringValueNode {
  kind: 'StringValue';
  value: string;
}

export interface BooleanValueNode {
  kind: 'BooleanValue';
  value: boolean;
}

export interface NullValueNode {
  kind: 'NullValue';
}

export interface EnumValueNode {
  kind: 'EnumValue';
  value: string;
}

export interface ListValueNode {
  kind: 'ListValue';
  values: ValueNode[];
}

export interface ObjectValueNode {
  kind: 'ObjectValue';
  fields: ObjectFieldNode[];
}

export interface ObjectFieldNode {
  kind: 'ObjectField';
  name: string;
  value: ValueNode;
}

class Tokenizer {
  private input: string;
  private pos = 0;
  private length: number;

  constructor(input: string) {
    this.input = input;
    this.length = input.length;
  }

  public tokenize(): string[] {
    const tokens: string[] = [];
    while (this.pos < this.length) {
      const c = this.input[this.pos];

      if (c <= ' ' || c === ',') {
        this.pos++;
        continue;
      }

      if (c === '#') {
        while (this.pos < this.length && this.input[this.pos] !== '\n' && this.input[this.pos] !== '\r') {
          this.pos++;
        }
        continue;
      }

      if (c === '{' || c === '}' || c === '(' || c === ')' || c === '[' || c === ']' || c === ':' || c === '!' || c === '=') {
        tokens.push(c);
        this.pos++;
        continue;
      }

      if (c === '.' && this.input.substr(this.pos, 3) === '...') {
        tokens.push('...');
        this.pos += 3;
        continue;
      }

      if (c === '$') {
        this.pos++;
        const name = this.readName();
        if (!name) throw new Error(`Invalid variable at position ${this.pos}`);
        tokens.push('$' + name);
        continue;
      }

      if (c === '"') {
        tokens.push(this.readString());
        continue;
      }

      if ((c >= '0' && c <= '9') || c === '-') {
        tokens.push(this.readNumber());
        continue;
      }

      if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
        tokens.push(this.readName());
        continue;
      }

      throw new Error(`Unexpected character ${JSON.stringify(c)} at position ${this.pos}`);
    }
    return tokens;
  }

  private readName(): string {
    const start = this.pos;
    while (this.pos < this.length) {
      const c = this.input[this.pos];
      if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_') {
        this.pos++;
      } else {
        break;
      }
    }
    return this.input.slice(start, this.pos);
  }

  private readString(): string {
    this.pos++; // skip opening quote
    let result = '';
    while (this.pos < this.length) {
      const c = this.input[this.pos];
      if (c === '"') {
        this.pos++;
        return '"' + result + '"';
      }
      if (c === '\\') {
        this.pos++;
        if (this.pos < this.length) {
          result += this.input[this.pos];
          this.pos++;
        }
      } else {
        result += c;
        this.pos++;
      }
    }
    throw new Error('Unterminated string literal');
  }

  private readNumber(): string {
    const start = this.pos;
    if (this.input[this.pos] === '-') this.pos++;
    while (this.pos < this.length && this.input[this.pos] >= '0' && this.input[this.pos] <= '9') {
      this.pos++;
    }
    let isFloat = false;
    if (this.pos < this.length && this.input[this.pos] === '.') {
      isFloat = true;
      this.pos++;
      while (this.pos < this.length && this.input[this.pos] >= '0' && this.input[this.pos] <= '9') {
        this.pos++;
      }
    }
    if (this.pos < this.length && (this.input[this.pos] === 'e' || this.input[this.pos] === 'E')) {
      isFloat = true;
      this.pos++;
      if (this.pos < this.length && (this.input[this.pos] === '+' || this.input[this.pos] === '-')) this.pos++;
      while (this.pos < this.length && this.input[this.pos] >= '0' && this.input[this.pos] <= '9') {
        this.pos++;
      }
    }
    return this.input.slice(start, this.pos);
  }
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new Error('Unexpected end of input');
    this.pos++;
    return tok;
  }

  private eat(val: string): string {
    const tok = this.next();
    if (tok !== val) throw new Error(`Expected ${JSON.stringify(val)}, got ${JSON.stringify(tok)}`);
    return tok;
  }

  private isName(tok: string | undefined): boolean {
    if (!tok) return false;
    if (tok.startsWith('$')) return false;
    if (tok.startsWith('"')) return false;
    if (/^[0-9.-]/.test(tok)) return false;
    const punctuators = ['{', '}', '(', ')', '[', ']', ':', ',', '!', '...'];
    return !punctuators.includes(tok);
  }

  public parseDocument(): Document {
    const definitions: Definition[] = [];
    while (this.peek() !== undefined) {
      definitions.push(this.parseDefinition());
    }
    return { kind: 'Document', definitions };
  }

  private parseDefinition(): Definition {
    const tok = this.peek();
    if (tok === 'fragment') {
      return this.parseFragmentDefinition();
    }
    if (tok === 'query' || tok === 'mutation' || tok === 'subscription' || tok === '{') {
      return this.parseOperationDefinition();
    }
    throw new Error(`Unexpected token at start of definition: ${JSON.stringify(tok)}`);
  }

  private parseOperationDefinition(): OperationDefinition {
    let operation: OperationType = 'query';
    let name: string | undefined;
    const variableDefinitions: VariableDefinition[] = [];
    const directives: Directive[] = [];

    if (this.isName(this.peek())) {
      const tok = this.peek();
      if (tok === 'query' || tok === 'mutation' || tok === 'subscription') {
        operation = this.next() as OperationType;
        if (this.isName(this.peek())) {
          name = this.next();
        }
      } else {
        operation = 'query';
      }
    } else if (this.peek() === '{') {
      operation = 'query';
    }

    if (this.peek() === '(') {
      variableDefinitions.push(...this.parseVariableDefinitions());
    }

    while (this.peek() === '@') {
      directives.push(this.parseDirective());
    }

    const selectionSet = this.parseSelectionSet();

    return {
      kind: 'OperationDefinition',
      operation,
      name,
      variableDefinitions,
      directives,
      selectionSet,
    };
  }

  private parseFragmentDefinition(): FragmentDefinition {
    this.eat('fragment');
    const name = this.next();
    this.eat('on');
    const typeCondition = this.next();
    const directives: Directive[] = [];
    while (this.peek() === '@') {
      directives.push(this.parseDirective());
    }
    const selectionSet = this.parseSelectionSet();
    return {
      kind: 'FragmentDefinition',
      name,
      typeCondition,
      directives,
      selectionSet,
    };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    this.eat('(');
    const defs: VariableDefinition[] = [];
    while (this.peek() !== ')' && this.peek() !== undefined) {
      const varTok = this.next();
      if (!varTok.startsWith('$')) throw new Error(`Expected variable starting with $, got ${varTok}`);
      const variable: Variable = {
        kind: 'Variable',
        name: varTok.slice(1),
      };
      this.eat(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.peek() === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({
        kind: 'VariableDefinition',
        variable,
        type,
        defaultValue,
      });
      if (this.peek() === ',') this.next();
    }
    this.eat(')');
    return defs;
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.peek() === '[') {
      this.next();
      const inner = this.parseType();
      this.eat(']');
      type = { kind: 'ListType', type: inner };
    } else {
      const name = this.next();
      type = { kind: 'NamedType', name };
    }
    if (this.peek() === '!') {
      this.next();
      type = { kind: 'NonNullType', type: type as any };
    }
    return type;
  }

  private parseSelectionSet(): SelectionSet {
    this.eat('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      selections.push(this.parseSelection());
    }
    this.eat('}');
    return { kind: 'SelectionSet', selections };
  }

  private parseSelection(): Selection {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        const directives: Directive[] = [];
        while (this.peek() === '@') {
          directives.push(this.parseDirective());
        }
        const selectionSet = this.parseSelectionSet();
        return {
          kind: 'InlineFragment',
          typeCondition,
          directives,
          selectionSet,
        };
      } else if (this.isName(this.peek())) {
        const name = this.next();
        const directives: Directive[] = [];
        while (this.peek() === '@') {
          directives.push(this.parseDirective());
        }
        return {
          kind: 'FragmentSpread',
          name,
          directives,
        };
      } else {
        const directives: Directive[] = [];
        while (this.peek() === '@') {
          directives.push(this.parseDirective());
        }
        const selectionSet = this.parseSelectionSet();
        return {
          kind: 'InlineFragment',
          directives,
          selectionSet,
        };
      }
    }

    let nameOrAlias = this.next();
    let alias: string | undefined;
    let fieldName: string;

    if (this.peek() === ':') {
      this.next();
      alias = nameOrAlias;
      fieldName = this.next();
    } else {
      fieldName = nameOrAlias;
    }

    const args: Argument[] = [];
    if (this.peek() === '(') {
      args.push(...this.parseArguments());
    }

    const directives: Directive[] = [];
    while (this.peek() === '@') {
      directives.push(this.parseDirective());
    }

    let selectionSet: SelectionSet | undefined;
    if (this.peek() === '{') {
      selectionSet = this.parseSelectionSet();
    }

    return {
      kind: 'Field',
      alias,
      name: fieldName,
      arguments: args,
      directives,
      selectionSet,
    };
  }

  private parseArguments(): Argument[] {
    this.eat('(');
    const args: Argument[] = [];
    while (this.peek() !== ')' && this.peek() !== undefined) {
      const name = this.next();
      this.eat(':');
      const value = this.parseValue();
      args.push({ kind: 'Argument', name, value });
      if (this.peek() === ',') this.next();
    }
    this.eat(')');
    return args;
  }

  private parseDirective(): Directive {
    this.eat('@');
    const name = this.next();
    const args: Argument[] = [];
    if (this.peek() === '(') {
      args.push(...this.parseArguments());
    }
    return { kind: 'Directive', name, arguments: args };
  }

  private parseValue(): ValueNode {
    const tok = this.peek();
    if (tok === undefined) throw new Error('Unexpected end of input while parsing value');

    if (tok.startsWith('$')) {
      this.next();
      return { kind: 'Variable', name: tok.slice(1) };
    }

    if (tok.startsWith('"')) {
      this.next();
      const strVal = tok.slice(1, -1);
      return { kind: 'StringValue', value: strVal };
    }

    if (tok === 'true' || tok === 'false') {
      this.next();
      return { kind: 'BooleanValue', value: tok === 'true' };
    }

    if (tok === 'null') {
      this.next();
      return { kind: 'NullValue' };
    }

    if (tok === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) {
        values.push(this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.eat(']');
      return { kind: 'ListValue', values };
    }

    if (tok === '{') {
      this.next();
      const fields: ObjectFieldNode[] = [];
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const name = this.next();
        this.eat(':');
        const value = this.parseValue();
        fields.push({ kind: 'ObjectField', name, value });
        if (this.peek() === ',') this.next();
      }
      this.eat('}');
      return { kind: 'ObjectValue', fields };
    }

    this.next();
    if (/^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(tok)) {
      if (tok.includes('.') || tok.includes('e') || tok.includes('E')) {
        return { kind: 'FloatValue', value: tok };
      }
      return { kind: 'IntValue', value: tok };
    }

    return { kind: 'EnumValue', value: tok };
  }
}

export function parse(query: string): Document {
  const tokenizer = new Tokenizer(query);
  const tokens = tokenizer.tokenize();
  const parser = new Parser(tokens);
  return parser.parseDocument();
}
