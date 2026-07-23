'use strict';

const assert = require('assert');
const path = require('path');
const { transformJsx, ATTR_SOURCE, ATTR_COMPONENT } = require('../src/transform');

const sample = `
import React from 'react';

export function Header() {
  return (
    <header className="site-header">
      <p className="mb-1">Hello</p>
    </header>
  );
}
`;

const filePath = path.join(process.cwd(), 'src', 'components', 'Header.tsx');
const out = transformJsx({ content: sample, filePath, cwd: process.cwd() });

assert.ok(out.includes(ATTR_SOURCE), 'should inject data-kexari-source');
assert.ok(out.includes(ATTR_COMPONENT), 'should inject data-kexari-component');
assert.ok(out.includes('Header'), 'should include component name');
assert.ok(/data-kexari-source="[^"]*Header\.tsx:\d+:\d+"/.test(out), 'source format file:line:col');
assert.ok(out.includes('data-kexari-component="Header"'), 'component attr');

// Should not inject on PascalCase components
const comp = `
export function Page() {
  return <Button label="x" />;
}
`;
const out2 = transformJsx({
  content: comp,
  filePath: path.join(process.cwd(), 'src', 'Page.tsx'),
  cwd: process.cwd()
});
assert.ok(!out2.includes('data-kexari-source'), 'skip React components');

console.log('ok — transform tests passed');
