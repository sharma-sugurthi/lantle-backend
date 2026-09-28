/**
 * Mirror of src/data/taxonomy.ts in the site repo. Keep the two in sync when adding a vertical or a feature label.
 */
export type Vertical = { slug: string; name: string; short: string; categories: string[] };

export const VERTICALS: Vertical[] = [
  { slug: 'finance', name: 'Finance and accounting', short: 'Finance', categories: ['Bookkeeping', 'Accounts payable', 'Expense management', 'FP&A and forecasting', 'Tax', 'Invoicing and AR', 'Spend cards', 'Business operations'] },
  { slug: 'marketing', name: 'Marketing', short: 'Marketing', categories: ['SEO and search', 'Content and copywriting', 'Email marketing', 'Social media', 'Advertising', 'Marketing analytics'] },
  { slug: 'sales', name: 'Sales', short: 'Sales', categories: ['CRM', 'Prospecting and outbound', 'Sales enablement', 'Proposals and quoting', 'Conversation intelligence'] },
  { slug: 'customer-support', name: 'Customer support', short: 'Support', categories: ['Chatbots and agents', 'Help desk', 'Voice and call centre', 'Feedback and surveys', 'Knowledge base'] },
  { slug: 'productivity', name: 'Productivity', short: 'Productivity', categories: ['Writing and notes', 'Meetings and transcription', 'Project management', 'Automation and workflows', 'Search and knowledge'] },
  { slug: 'developer-tools', name: 'Developer tools', short: 'Developer', categories: ['Coding assistants', 'Testing and QA', 'DevOps and infrastructure', 'APIs and integration', 'Documentation'] },
  { slug: 'design', name: 'Design and creative', short: 'Design', categories: ['Image generation', 'Video', 'Audio and voice', 'UI and prototyping', 'Presentations'] },
  { slug: 'data', name: 'Data and analytics', short: 'Data', categories: ['BI and dashboards', 'Data pipelines', 'Spreadsheets', 'Research and insights'] },
  { slug: 'hr', name: 'HR and recruiting', short: 'HR', categories: ['Recruiting and sourcing', 'Onboarding and training', 'Performance and engagement', 'Payroll and benefits'] },
  { slug: 'legal', name: 'Legal and compliance', short: 'Legal', categories: ['Contract review', 'Compliance and policy', 'E-signature', 'IP and trademarks'] },
  { slug: 'ecommerce', name: 'Ecommerce and retail', short: 'Ecommerce', categories: ['Storefront and merchandising', 'Product content', 'Inventory and fulfilment', 'Pricing and promotions'] },
  { slug: 'operations', name: 'Operations and IT', short: 'Operations', categories: ['Procurement', 'Logistics and supply chain', 'Scheduling', 'Security and IT'] },
];

/**
 * Controlled feature vocabulary per vertical. The comparison matrix shows a tick when a tool lists a label,
 * a cross only when the label is in this list and the tool does not list it, and nothing otherwise.
 * Unknown is never rendered as a no.
 */
export const FEATURES: Record<string, string[]> = {
  finance: ['Bank feed sync', 'Automatic categorisation', 'Receipt capture', 'Invoice OCR and data extraction', 'Approval workflows', 'Corporate cards', 'Bill pay', 'Expense reimbursement', 'Multi-entity', 'Multi-currency', 'Accounting sync (QuickBooks, Xero, NetSuite)', 'Forecasting and scenarios', 'Budgeting', 'Reporting dashboards', 'Tax calculation and filing', 'Audit trail', 'Mobile app', 'API', 'SSO'],
  marketing: ['Keyword research', 'Rank tracking', 'Site audit', 'Backlink analysis', 'Content editor with SEO scoring', 'AI writing', 'Brand voice', 'Email campaigns', 'SMS campaigns', 'Marketing automation flows', 'Segmentation', 'A/B testing', 'Social scheduling', 'Ad management', 'Attribution and analytics', 'Templates library', 'Collaboration and approvals', 'API', 'SSO'],
  sales: ['Contact database', 'Email finder and verification', 'Sequences and cadences', 'Dialer', 'CRM pipeline', 'Data enrichment', 'Intent signals', 'Call recording and transcription', 'Deal coaching', 'Forecasting', 'Workflow automation', 'CRM sync (Salesforce, HubSpot)', 'Reporting', 'Shared inbox', 'API', 'SSO'],
  'customer-support': ['Shared inbox', 'Ticketing and SLAs', 'Live chat', 'AI agent (autonomous replies)', 'AI assist for agents', 'Knowledge base', 'Help centre', 'Email channel', 'WhatsApp and social channels', 'Voice and phone', 'Chatbot builder', 'Customer and order data in view', 'Automations and macros', 'CSAT surveys', 'Reporting', 'Multilingual', 'API', 'SSO'],
  productivity: ['Docs and wiki', 'Databases and tables', 'Meeting transcription', 'AI summaries', 'Action items and follow-ups', 'Task management', 'Calendar integration', 'Automations and workflows', 'Templates', 'Search across tools', 'Offline access', 'Mobile app', 'Real-time collaboration', 'Version history', 'Permissions and admin controls', 'API', 'SSO'],
  'developer-tools': ['Code completion', 'Chat with codebase context', 'Agent mode (multi-file edits)', 'Terminal and command execution', 'Code review on pull requests', 'Test generation', 'Choice of models', 'Bring your own API key', 'Self-hosted or on-prem option', 'VS Code plugin', 'JetBrains plugin', 'CLI', 'Docs hosting', 'API reference generation', 'Usage analytics', 'Enterprise privacy mode', 'SSO'],
  design: ['Text to image', 'Image editing (inpainting, upscaling)', 'Text to video', 'Video editing', 'Voice generation', 'Voice cloning', 'Dubbing and translation', 'Design canvas and prototyping', 'Components and design systems', 'Team libraries', 'Brand kit', 'Commercial use licence', 'Collaboration and comments', 'Templates', 'Export formats (SVG, PDF, MP4)', 'API', 'SSO'],
  data: ['Dashboards and visualisation', 'Natural language queries', 'Managed connectors', 'Transformations (SQL, dbt)', 'Scheduling and alerts', 'Embedded analytics', 'Data modelling and governance', 'Row-level security', 'Spreadsheet interface', 'Python and R notebooks', 'Warehouse integration', 'Real-time or CDC sync', 'Self-hosted option', 'API', 'SSO'],
  hr: ['Job posting distribution', 'Applicant tracking', 'Candidate sourcing', 'Interview scheduling', 'Structured interview kits', 'Offer management', 'Onboarding workflows', 'Performance reviews', 'Goals and OKRs', '1:1s and feedback', 'Engagement surveys', 'Payroll', 'Contractor payments', 'Benefits administration', 'Employer of record', 'Reporting and analytics', 'API', 'SSO'],
  legal: ['Contract drafting assistant', 'Clause library and playbooks', 'Contract review and redlining', 'Repository and search', 'Approval workflows', 'E-signature', 'Templates', 'Obligation and renewal tracking', 'Compliance automation (SOC 2, ISO 27001)', 'Continuous control monitoring', 'Vendor risk management', 'Policy management', 'Audit support', 'Word integration', 'Salesforce integration', 'API', 'SSO'],
  ecommerce: ['Hosted storefront', 'Product catalogue', 'Checkout and payments', 'Product recommendations', 'Upsell and cross-sell', 'Merchandising rules', 'Competitor price tracking', 'Dynamic repricing', 'Demand forecasting', 'Purchase order planning', 'Multi-channel inventory', 'Marketplace integrations', 'Analytics', 'App ecosystem', 'Themes and templates', 'API', 'SSO'],
  operations: ['Purchase intake and approvals', 'Vendor management', 'Contract and renewal tracking', 'Freight booking', 'Customs and compliance', 'Shipment tracking', 'Inventory visibility', 'Booking pages', 'Round robin and routing', 'Reminders and workflows', 'Payments collection', 'Endpoint protection', 'Threat detection and response', 'Identity and access', 'Device management', 'Reporting', 'API', 'SSO'],
};

export const PLATFORMS = ['Web', 'macOS', 'Windows', 'Linux', 'iOS', 'Android', 'VS Code', 'JetBrains', 'CLI', 'Slack', 'Microsoft Teams', 'Chrome extension', 'Word', 'Google Workspace', 'WordPress', 'Shopify'];
export const DEPLOYMENTS = ['cloud', 'self-hosted', 'both'] as const;
export const COMPANY_SIZES = ['solo', 'small', 'mid', 'enterprise'] as const;

export const OTHER_CATEGORY = 'Other (tell us in the notes)';
export const PRICING = ['Free', 'Freemium', 'Paid', 'Enterprise'] as const;

export function getVertical(slug: string): Vertical | undefined {
  return VERTICALS.find((v) => v.slug === slug);
}

/** Valid if the category belongs to the vertical. "Other" is accepted at submission and must be fixed before approval. */
export function isValidCategory(vertical: string, category: string, allowOther = false): boolean {
  const v = getVertical(vertical);
  if (!v) return false;
  return v.categories.includes(category) || (allowOther && category === OTHER_CATEGORY);
}
