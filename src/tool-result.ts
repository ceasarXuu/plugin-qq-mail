import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { publicError } from './errors.js';

export async function toolResult(operation: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await operation();
    return { content: [{ type: 'text', text: JSON.stringify(data, (_key, value) => typeof value === 'bigint' ? String(value) : value) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: publicError(error) }) }] };
  }
}

export const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
