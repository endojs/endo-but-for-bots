// @ts-check

/**
 * AST-backed inspection of rendered TypeScript declaration source, for tests
 * that assert on the type-alias names and object-type members a code-mode
 * declaration string contains.
 *
 * This is a test-only inspection tool: it reads the declaration text the
 * generators already produced and answers structural questions about it with
 * the `typescript` compiler API. It does not resolve imports, follow type
 * references, or render anything, so it must not be reached for from
 * production code as a second declaration generator.
 */

import ts from 'typescript';

/**
 * @param {string} source
 * @returns {ts.SourceFile}
 */
const parseSource = source =>
  ts.createSourceFile('declarations.ts', source, ts.ScriptTarget.Latest, true);

/**
 * List the names of every top-level `type <Name> = ...;` alias declared in
 * `source`.
 *
 * @param {string} source
 * @returns {string[]}
 */
export const listDeclaredTypeNames = source => {
  const sourceFile = parseSource(source);
  const names = [];
  for (const stmt of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(stmt)) {
      names.push(stmt.name.text);
    }
  }
  return names;
};
harden(listDeclaredTypeNames);

/**
 * @param {ts.TypeElement} member
 * @param {string} typeName
 * @returns {string}
 */
const memberName = (member, typeName) => {
  const { name } = member;
  if (name === undefined || !ts.isIdentifier(name)) {
    throw new Error(
      `unsupported member name on type alias ${typeName}: ${
        name === undefined ? '<none>' : name.getText()
      }`,
    );
  }
  return name.text;
};

/**
 * @param {ts.TypeLiteralNode} typeLiteral
 * @param {string} typeName
 * @returns {string[]}
 */
const typeLiteralMemberNames = (typeLiteral, typeName) =>
  typeLiteral.members.map(member => {
    if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) {
      throw new Error(
        `unsupported member kind on type alias ${typeName}: ${
          ts.SyntaxKind[member.kind]
        }`,
      );
    }
    return memberName(member, typeName);
  });

/**
 * Return the immediate (top-level) member names of the object-type alias
 * named `typeName` declared in `source`.
 *
 * Only the alias's own `PropertySignature`/`MethodSignature` members are
 * reported: a nested object type is nowhere descended into, so a property of
 * a nested object type is never mistaken for a member of the outer alias. An
 * intersection type (`A & { ... }`) reports only the members declared by its
 * own object-type-literal operands, not members reached through a type
 * reference operand (e.g. `A`) — matching the alias's own declared surface
 * rather than its full resolved shape.
 *
 * Throws when `typeName` is not declared in `source`, when the alias does not
 * resolve to an object type (directly, or through an intersection with at
 * least one object-type-literal operand), or when a member has a form this
 * inspector does not support (index signature, computed name, and so on).
 *
 * @param {string} source
 * @param {string} typeName
 * @returns {string[]}
 */
export const listDeclaredTypeMembers = (source, typeName) => {
  const sourceFile = parseSource(source);
  const alias = sourceFile.statements.find(
    stmt => ts.isTypeAliasDeclaration(stmt) && stmt.name.text === typeName,
  );
  if (alias === undefined) {
    throw new Error(`no type alias named ${typeName} in declaration source`);
  }
  const { type } = /** @type {ts.TypeAliasDeclaration} */ (alias);
  if (ts.isTypeLiteralNode(type)) {
    return typeLiteralMemberNames(type, typeName);
  }
  if (ts.isIntersectionTypeNode(type)) {
    const literalOperands = type.types.filter(ts.isTypeLiteralNode);
    if (literalOperands.length === 0) {
      throw new Error(
        `type alias ${typeName} is an intersection with no object type literal operand`,
      );
    }
    return literalOperands.flatMap(literal =>
      typeLiteralMemberNames(literal, typeName),
    );
  }
  throw new Error(
    `type alias ${typeName} is not an object type (got ${
      ts.SyntaxKind[type.kind]
    })`,
  );
};
harden(listDeclaredTypeMembers);
