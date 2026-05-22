import typescriptParser from '@typescript-eslint/parser';
import { describe, expect, test } from 'vitest';

import {
  getChildNodes,
  getStaticMemberPropertyName,
  getStaticPropertyKeyName,
  isAstNode,
} from '../../eslint-rules/utils.js';

describe('eslint AST utilities', () => {
  test('returns direct child nodes without parser metadata', () => {
    const program = parseProgram('const value = "src/cli.ts"; // src/cli.ts\n');

    expect(getChildNodes(program).map((node) => node.type)).toEqual([
      'VariableDeclaration',
    ]);
  });

  test('rejects comments and node-like plain objects', () => {
    const program = parseProgram('const value = 1; // marker\n');
    const comments = program.comments ?? [];

    expect(comments).toHaveLength(1);
    expect(comments.every((comment) => !isAstNode(comment))).toBe(true);
    expect(isAstNode({ name: 'fake', type: 'Identifier' })).toBe(false);
  });

  test('reads static member and property names', () => {
    const program = parseProgram(`
      object.name;
      object['name'];
      object[0];
      const value = { name: 1, ['label']: 2, [field]: 3, 4: 4 };
    `);
    const dotMember = getMemberExpression(getStatement(program, 0));
    const quotedMember = getMemberExpression(getStatement(program, 1));
    const numericMember = getMemberExpression(getStatement(program, 2));
    const declaration = getVariableDeclaration(getStatement(program, 3));
    const properties = getObjectProperties(declaration.declarations[0]);

    expect(getStaticMemberPropertyName(dotMember)).toBe('name');
    expect(getStaticMemberPropertyName(quotedMember)).toBe('name');
    expect(getStaticMemberPropertyName(numericMember)).toBeUndefined();
    expect(
      properties.map((property) => getStaticPropertyKeyName(property)),
    ).toEqual(['name', 'label', undefined, undefined]);
  });
});

function parseProgram(code) {
  return typescriptParser.parseForESLint(code, {
    comment: true,
    loc: true,
    range: true,
    sourceType: 'module',
    tokens: true,
  }).ast;
}

function getStatement(program, index) {
  const statement = program.body[index];

  if (statement === undefined) {
    throw new Error(`Invalid test program — expected statement ${index}.`);
  }

  return statement;
}

function getMemberExpression(statement) {
  if (statement.type !== 'ExpressionStatement') {
    throw new Error(
      `Invalid test statement "${statement.type}" — expected an expression statement.`,
    );
  }

  if (statement.expression.type !== 'MemberExpression') {
    throw new Error(
      `Invalid test expression "${statement.expression.type}" — expected a member expression.`,
    );
  }

  return statement.expression;
}

function getVariableDeclaration(statement) {
  if (statement.type !== 'VariableDeclaration') {
    throw new Error(
      `Invalid test statement "${statement.type}" — expected a variable declaration.`,
    );
  }

  return statement;
}

function getObjectProperties(declarator) {
  if (declarator.init?.type !== 'ObjectExpression') {
    throw new Error('Invalid test value — expected an object literal.');
  }

  return declarator.init.properties.filter((property) => {
    return property.type === 'Property';
  });
}
