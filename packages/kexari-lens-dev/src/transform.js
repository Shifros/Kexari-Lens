'use strict';

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');
const path = require('path');

const ATTR_SOURCE = 'data-kexari-source';
const ATTR_COMPONENT = 'data-kexari-component';

/**
 * @param {string} filePath
 * @param {string} [cwd]
 * @returns {string}
 */
function toProjectRelative(filePath, cwd = process.cwd()) {
  const abs = path.resolve(filePath);
  const root = path.resolve(cwd);
  let rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..')) {
    rel = abs;
  }
  return rel.replace(/\\/g, '/');
}

/**
 * @param {import('@babel/types').JSXIdentifier | import('@babel/types').JSXMemberExpression | import('@babel/types').JSXNamespacedName} name
 * @returns {boolean}
 */
function isHostElement(name) {
  if (t.isJSXIdentifier(name)) {
    const n = name.name;
    // lowercase HTML/SVG tags only — React components stay PascalCase
    return n.length > 0 && n[0] === n[0].toLowerCase() && !n.includes('.');
  }
  // motion.div / svg.path style — treat as host-like when property is lowercase
  if (t.isJSXMemberExpression(name) && t.isJSXIdentifier(name.property)) {
    const prop = name.property.name;
    return prop.length > 0 && prop[0] === prop[0].toLowerCase();
  }
  return false;
}

/**
 * @param {import('@babel/traverse').NodePath} jsxPath
 * @returns {string}
 */
function findEnclosingComponentName(jsxPath) {
  let current = jsxPath.parentPath;
  while (current) {
    const node = current.node;

    if (t.isFunctionDeclaration(node) && node.id && node.id.name) {
      return node.id.name;
    }

    if (
      (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) &&
      current.parentPath
    ) {
      const parent = current.parentPath.node;
      if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
        return parent.id.name;
      }
      if (t.isObjectProperty(parent) && t.isIdentifier(parent.key)) {
        return parent.key.name;
      }
      if (
        t.isAssignmentExpression(parent) &&
        t.isMemberExpression(parent.left) &&
        t.isIdentifier(parent.left.property)
      ) {
        return parent.left.property.name;
      }
    }

    if (
      t.isVariableDeclarator(node) &&
      t.isIdentifier(node.id) &&
      (t.isFunctionExpression(node.init) || t.isArrowFunctionExpression(node.init))
    ) {
      return node.id.name;
    }

    current = current.parentPath;
  }
  return '';
}

/**
 * @param {import('@babel/types').JSXOpeningElement} opening
 * @param {string} attrName
 * @returns {boolean}
 */
function hasAttr(opening, attrName) {
  return opening.attributes.some(
    (attr) =>
      t.isJSXAttribute(attr) &&
      t.isJSXIdentifier(attr.name) &&
      attr.name.name === attrName
  );
}

/**
 * Transform JSX/TSX source to inject data-kexari-* attributes on host elements.
 * @param {{ content: string, filePath: string, cwd?: string }} opts
 * @returns {string}
 */
function transformJsx(opts) {
  const { content, filePath, cwd = process.cwd() } = opts;
  if (!content || !/\.[jt]sx$/i.test(filePath)) {
    return content;
  }

  // Skip node_modules and Next build output
  const normalized = filePath.replace(/\\/g, '/');
  if (
    normalized.includes('/node_modules/') ||
    normalized.includes('/.next/') ||
    normalized.includes('/dist/')
  ) {
    return content;
  }

  let ast;
  try {
    ast = parser.parse(content, {
      sourceType: 'module',
      sourceFilename: filePath,
      plugins: [
        'jsx',
        'typescript',
        'decorators-legacy',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'dynamicImport',
        'importMeta',
        'topLevelAwait',
        'importAttributes'
      ]
    });
  } catch {
    return content;
  }

  const relativePath = toProjectRelative(filePath, cwd);
  let mutated = false;

  traverse(ast, {
    JSXOpeningElement(jsxPath) {
      const opening = jsxPath.node;
      if (!isHostElement(opening.name)) {
        return;
      }
      if (hasAttr(opening, ATTR_SOURCE)) {
        return;
      }

      const loc = opening.loc;
      const line = loc && loc.start ? loc.start.line : 1;
      const col = loc && loc.start ? loc.start.column + 1 : 1;
      const sourceValue = `${relativePath}:${line}:${col}`;

      opening.attributes.push(
        t.jsxAttribute(
          t.jsxIdentifier(ATTR_SOURCE),
          t.stringLiteral(sourceValue)
        )
      );

      const componentName = findEnclosingComponentName(jsxPath);
      if (componentName && !hasAttr(opening, ATTR_COMPONENT)) {
        opening.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier(ATTR_COMPONENT),
            t.stringLiteral(componentName)
          )
        );
      }

      mutated = true;
    }
  });

  if (!mutated) {
    return content;
  }

  const result = generate(
    ast,
    {
      retainLines: true,
      compact: false,
      decoratorsBeforeExport: true
    },
    content
  );

  return result.code;
}

module.exports = {
  transformJsx,
  toProjectRelative,
  ATTR_SOURCE,
  ATTR_COMPONENT
};
