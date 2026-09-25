/**
 * Mirror of src/data/taxonomy.ts in the site repo. Keep the two in sync when adding a vertical.
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
