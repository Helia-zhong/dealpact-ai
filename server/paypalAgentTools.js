import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { PayPalError, money } from './paypalClient.js';

// Use the official toolkit's schemas; payment transport stays observable in PayPalClient.
const toolkit = new PayPalAgentToolkit({
  configuration: {
    context: { sandbox: true },
    actions: { orders: { create: true, get: true, capture: true }, invoices: { create: true } },
  },
}).getTools();

const aliases = {
  paypal_create_order: 'create_order',
  paypal_get_order: 'get_order',
  paypal_capture_order: 'pay_order',
  paypal_create_draft_invoice: 'create_invoice',
};
const descriptions = {
  paypal_create_order: 'Create or reuse a PayPal Sandbox order for an agreed milestone. The server supplies the fixed amount and idempotency key.',
  paypal_get_order: 'Read a PayPal Sandbox order belonging to the specified pact and milestone.',
  paypal_capture_order: 'Capture an owned milestone after QA and buyer approval, or explicitly simulate settlement after live order verification when instantSettlement is true.',
  paypal_create_draft_invoice: 'Create or reuse a draft milestone invoice. This tool never sends the invoice.',
};
const identifier = { type: 'string', minLength: 1, maxLength: 100 };

export const PAYPAL_TOOL_DEFINITIONS = Object.keys(aliases).map((name) => {
  const properties = { pactId: { ...identifier }, milestoneId: { ...identifier } };
  if (['paypal_get_order', 'paypal_capture_order'].includes(name)) properties.orderId = { type: 'string', pattern: '^[A-Z0-9]{17,32}$' };
  if (name === 'paypal_capture_order') properties.instantSettlement = { type: 'boolean', description: 'Allow a labeled simulated settlement if the verified live Sandbox order still needs buyer approval.' };
  if (name === 'paypal_create_draft_invoice') properties.recipientEmail = { type: ['string', 'null'], description: 'Use null for the agreed pact recipient.' };
  const required = Object.keys(properties).filter((key) => key !== 'instantSettlement');
  return { type: 'function', function: { name, description: descriptions[name], strict: true,
    parameters: { type: 'object', properties, required, additionalProperties: false } } };
});

export const PAYPAL_MCP_TOOLS = PAYPAL_TOOL_DEFINITIONS.map(({ function: tool }) => ({
  name: tool.name, description: tool.description, inputSchema: tool.parameters,
}));

function invalid(message, status = 400) {
  return new PayPalError(message, { status });
}

export class PayPalAgentTools {
  constructor({ withMilestone, handlers, telemetry }) {
    this.withMilestone = withMilestone;
    this.handlers = handlers;
    this.telemetry = telemetry;
  }

  async execute(name, input) {
    const started = performance.now();
    let args;
    let result;
    let failure;
    try {
      const definition = PAYPAL_TOOL_DEFINITIONS.find((tool) => tool.function.name === name)?.function;
      if (!definition) throw invalid('Unknown PayPal agent tool.');
      try { args = typeof input === 'string' ? JSON.parse(input) : input; }
      catch { throw invalid('Tool arguments must be valid JSON.'); }
      if (!args || Array.isArray(args) || typeof args !== 'object') throw invalid('Tool arguments must be an object.');
      const properties = definition.parameters.properties;
      if (Object.keys(args).some((key) => !Object.hasOwn(properties, key))) throw invalid('Unexpected PayPal tool argument.');
      for (const key of definition.parameters.required) {
        if (!Object.hasOwn(args, key)) throw invalid(`Missing tool argument: ${key}.`);
      }
      for (const key of Object.keys(args)) {
        const value = args[key];
        if (key === 'recipientEmail' && value === null) continue;
        if (properties[key].type === 'boolean') {
          if (typeof value !== 'boolean') throw invalid(`Invalid tool argument: ${key}.`);
          continue;
        }
        if (typeof value !== 'string' || !value.trim() || value.length > (key === 'recipientEmail' ? 254 : 100)) throw invalid(`Invalid tool argument: ${key}.`);
        if (properties[key].pattern && !new RegExp(properties[key].pattern).test(value)) throw invalid(`Invalid tool argument: ${key}.`);
      }
      result = await this.withMilestone(args.pactId, args.milestoneId, async ({ pact, milestone }) => {
        if (args.orderId && milestone.order?.data.id !== args.orderId) throw invalid('Order does not belong to the specified milestone.', 409);
        if (name === 'paypal_capture_order' && !milestone.audit?.passed) throw invalid('Capture is blocked: this milestone needs a passing QA audit.', 409);
        const value = money(milestone.amount);
        const officialInput = name === 'paypal_create_order'
          ? { currencyCode: 'USD', items: [{ name: milestone.title, quantity: 1, itemCost: Number(value), itemTotal: Number(value) }] }
          : name === 'paypal_create_draft_invoice'
            ? { currency_code: 'USD', primary_recipients: [{ billing_info: { email_address: args.recipientEmail ?? pact.recipientEmail } }],
              items: [{ name: milestone.title, quantity: '1', unit_amount: { currency_code: 'USD', value } }] }
            : { id: args.orderId };
        const validated = toolkit[aliases[name]].parameters.safeParse(officialInput);
        if (!validated.success) throw invalid('The milestone payment does not satisfy the PayPal Agent Toolkit schema.');
        const output = await this.handlers[name](pact, milestone, args);
        milestone.agentTool = name;
        return output;
      });
      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.telemetry?.record({
        source: 'AGENT', method: 'TOOL', endpoint: `/agent-tools/${Object.hasOwn(aliases, name) ? name : 'unknown'}`,
        mode: 'PAYPAL_AGENT_TOOLKIT', latencyMs: performance.now() - started,
        request: { body: { toolkitTool: Object.hasOwn(aliases, name) ? aliases[name] : null, arguments: args ?? null } },
        response: { status: failure?.status ?? (failure ? 500 : 200),
          body: failure ? { error: failure.message } : result },
      });
    }
  }

  async handleToolCall(call) {
    const result = await this.execute(call.function?.name, call.function?.arguments);
    return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) };
  }
}
