// @ts-nocheck - Browser fixture with test-only globals
/* eslint-disable no-underscore-dangle */

// Browser harness for the formula-inspector e2e suite
// (../formula-inspector.spec.ts). It mounts the real `valueComponent` (the
// Value modal with its Formula back face and retention-paths table) under the
// app's severe lockdown and the app's stylesheet, against a synthetic EndoHost
// built from a fixture, so the suite runs in a real browser without an Endo
// daemon.
//
// The spec drives it through `window.__testHarness`:
//
//   setFixture({ names, formulas, retentionPaths })
//     names           [{ name, type, id }] rendered as inventory rows
//     formulas        { [id]: FormulaRecord } served by `getFormula`
//     retentionPaths  { [id]: RetentionPath[] } served by `listRetentionPaths`
//   calls             every synthetic host call, as { method, args }
//
// Each row's inspect button calls `showValue(value, id, [name])`, the same call
// the inventory's inspect button makes.

import '../../../pre-lockdown.js';
import '@endo/init';

import harden from '@endo/harden';
import { Far } from '@endo/pass-style';
import { parseLocator } from '@endo/daemon/locator.js';
import { valueComponent } from '@endo/spaces-util/value-component.js';

/** @type {Array<{ method: string, args: unknown[] }>} */
const calls = [];

let fixture = { names: [], formulas: {}, retentionPaths: {} };

/** @type {Map<string, unknown>} */
const valuesById = new Map();

const valueFor = (id, type) => {
  let value = valuesById.get(id);
  if (!value) {
    value = Far(`Fixture ${type}`, {});
    valuesById.set(id, value);
  }
  return value;
};

const host = Far('HarnessEndoHost', {
  diagnostics() {
    return host;
  },
  getFormula(id) {
    calls.push({ method: 'getFormula', args: [id] });
    const record = fixture.formulas[id];
    if (!record) {
      throw Error(`No fixture formula for ${id}`);
    }
    return harden(record);
  },
  lookupById(id) {
    calls.push({ method: 'lookupById', args: [id] });
    const record = fixture.formulas[id];
    return valueFor(id, record ? record.type : 'value');
  },
  listRetentionPaths(locator) {
    calls.push({ method: 'listRetentionPaths', args: [locator] });
    const { number, node } = parseLocator(locator);
    const id = `${number}:${node}`;
    return harden(fixture.retentionPaths[id] || []);
  },
  reverseIdentify(id) {
    calls.push({ method: 'reverseIdentify', args: [id] });
    return harden(fixture.names.filter(n => n.id === id).map(n => n.name));
  },
  move(fromPath, toPath) {
    calls.push({ method: 'move', args: [fromPath, toPath] });
  },
  storeValue(_value, petNamePath) {
    calls.push({ method: 'storeValue', args: [petNamePath] });
  },
  adopt(number, edgeName, petNamePath) {
    calls.push({ method: 'adopt', args: [number, edgeName, petNamePath] });
  },
});

const $pets = document.getElementById('pets');
const { showValue } = valueComponent(
  document.getElementById('value-host'),
  host,
  {
    enterProfile: async () => {},
  },
);

const renderRows = () => {
  $pets.replaceChildren();
  for (const { name, type, id } of fixture.names) {
    const $row = document.createElement('div');
    $row.className = 'pet-item-row';
    $row.dataset.name = name;
    const $name = document.createElement('span');
    $name.className = 'pet-name';
    $name.textContent = name;
    const $inspect = document.createElement('button');
    $inspect.className = 'info-button';
    $inspect.title = `Inspect ${name}`;
    $inspect.textContent = 'ℹ';
    $inspect.addEventListener('click', () => {
      showValue(valueFor(id, type), id, [name]).catch(window.reportError);
    });
    $row.append($name, $inspect);
    $pets.appendChild($row);
  }
};

window.__testHarness = {
  setFixture(next) {
    fixture = {
      names: next.names || [],
      formulas: next.formulas || {},
      retentionPaths: next.retentionPaths || {},
    };
    valuesById.clear();
    calls.length = 0;
    renderRows();
  },
  calls,
};
window.__testHarnessReady = true;
