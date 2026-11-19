import assert from 'node:assert/strict';
import { visibleText } from './fixture.mjs';

export function assertPendingFold(request, node, memory) {
  const receipt = `Node ${node} is closed and its memory is recorded.`;
  assert.ok(request.messages.some((message) => message.role === 'tool' && visibleText(message).startsWith(receipt)),
    `The first sampling after closing ${node} must retain its successful tool result`);
  assert.ok(!visibleText(request.messages).includes(memory),
    `The first sampling after closing ${node} must not see the folded memory yet`);
}

export function assertFoldedMemory(request, node, memory) {
  const block = `<spine_memory node_id="${node}">\n${memory}\n</spine_memory>`;
  assert.ok(request.messages.some((message) => visibleText(message).includes(block)),
    `A later sampling must see folded memory for ${node}: ${memory}`);
}
