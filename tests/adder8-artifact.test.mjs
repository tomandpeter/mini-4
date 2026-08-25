import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { keccak256, toHex } from "viem";

const SOURCE_URL = new URL("../lib/adder8-tapeout.ts", import.meta.url);
const EXPECTED_SHA256 = "fcabd68bd2aecc2b53b3f660ca7aab8defa8d67c929e1c79ca763c9008ff4933";
const EXPECTED_KECCAK = "0x288a84a20d5e02e007179e97f7137375b5c8ebb7465f618ab84f054fe5570e60";

async function pinnedNetlist() {
  const source = await readFile(SOURCE_URL, "utf8");
  const match = source.match(/export const ADDER8_NETLIST =\s*\n\s*"(0x[0-9a-f]+)" as Hex;/);
  assert.ok(match, "pinned ADDER8_NETLIST constant must be present");
  return match[1];
}

function decodeCells(netlist) {
  const bytes = Buffer.from(netlist.slice(2), "hex");
  assert.equal(bytes.length, 476);
  assert.equal(bytes.length % 7, 0);
  const cells = [];
  for (let offset = 0; offset < bytes.length; offset += 7) {
    const output = 18 + cells.length;
    const opcode = bytes[offset];
    const left = bytes.readUIntBE(offset + 1, 3);
    const right = bytes.readUIntBE(offset + 4, 3);
    assert.equal(opcode, 0, "8-bit adder must not contain REF or LATCH opcodes");
    assert.ok(left < output && right < output, "gate references must only point backward");
    cells.push({ left, right });
  }
  return cells;
}

function evaluate(cells, a, b) {
  const signals = [0, 1];
  for (let bit = 0; bit < 8; bit += 1) signals.push((a >> bit) & 1);
  for (let bit = 0; bit < 8; bit += 1) signals.push((b >> bit) & 1);
  for (const cell of cells) signals.push(1 - (signals[cell.left] & signals[cell.right]));
  return signals.slice(-9).reduce((sum, bit, index) => sum | (bit << index), 0);
}

test("pinned task-38 netlist has the reviewed hashes and 68 NAND cells", async () => {
  const netlist = await pinnedNetlist();
  const bytes = Buffer.from(netlist.slice(2), "hex");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), EXPECTED_SHA256);
  assert.equal(keccak256(toHex(bytes)), EXPECTED_KECCAK);
  assert.equal(decodeCells(netlist).length, 68);
});

test("pinned task-38 netlist adds every pair from 0 through 255", async () => {
  const cells = decodeCells(await pinnedNetlist());
  for (let a = 0; a <= 255; a += 1) {
    for (let b = 0; b <= 255; b += 1) {
      assert.equal(evaluate(cells, a, b), a + b, `${a} + ${b}`);
    }
  }
});
