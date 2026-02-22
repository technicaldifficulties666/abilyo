# AI-Powered Web Accessibility Auditor

An intelligent web accessibility audit tool that uses AI (GPT-4o) to identify WCAG 2.2 Level AA violations, including "soft" accessibility issues that traditional automated scanners miss.

## Features

- **AI-Powered Analysis**: Uses GPT-4o to understand context and identify semantic accessibility issues
- **Visual Inspection**: Leverages Stagehand's AI vision to detect visual accessibility problems
- **WCAG 2.2 Level AA Compliance**: Maps violations to specific WCAG criteria
- **Code-Level Fixes**: Provides actual HTML/ARIA code snippets with suggested fixes
- **Semantic Understanding**: Identifies issues like poor heading hierarchy, non-descriptive link text, and logical flow problems

## Architecture

- **Mastra Agent**: `AODA-Auditor` orchestrates the audit workflow
- **Stagehand**: Browser automation with AI-powered observation and extraction
- **OpenAI GPT-4o**: Powers the intelligent analysis and reasoning
- **TypeScript + Zod**: Type-safe schemas and validation

## Prerequisites

- Node.js 18+ 
- OpenAI API key
- (Optional) BrowserBase account for cloud-based browser automation

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create a `.env` file (use `.env.example` as template):

```bash
OPENAI_API_KEY=your_openai_api_key_here
STAGEHAND_ENV=LOCAL

# Optional - for BrowserBase cloud execution
# BROWSERBASE_API_KEY=your_browserbase_api_key
# BROWSERBASE_PROJECT_ID=your_browserbase_project_id
```

### 3. Run an Audit

```bash
npm run audit https://example.com
```

Or using ts-node directly:

```bash
npx ts-node src/scripts/audit.ts https://example.com
```

## Output

The audit generates:

1. **Console Output**: Formatted report with issues, severity, and fixes
2. **JSON Report**: Saved to `reports/accessibility-report-[timestamp].json`

### Example Output Structure

```json
{
  "url": "https://example.com",
  "pageTitle": "Example Domain",
  "issues": [
    {
      "element": "img.header-logo",
      "elementType": "img",
      "issue": "Image missing alt attribute",
      "wcagCriteria": "1.1.1",
      "wcagName": "Non-text Content",
      "severity": "critical",
      "currentCode": "<img src='logo.png' class='header-logo'>",
      "suggestedFix": "<img src='logo.png' alt='Company Name - Home' class='header-logo'>",
      "explanation": "Images must have alt text to be accessible to screen readers..."
    }
  ],
  "summary": {
    "totalIssues": 10,
    "critical": 2,
    "serious": 4,
    "moderate": 3,
    "minor": 1
  }
}
```

## What It Detects

### Soft Issues (Beyond Traditional Scanners)

- **Alt text quality**: Not just presence, but descriptiveness
- **Heading hierarchy**: Logical structure and no skipped levels  
- **Link text**: Descriptive vs generic ("click here")
- **Button labels**: Clear purpose indication
- **Form labels**: Programmatic association, not just visual
- **Visual contrast**: Observable low-contrast elements
- **Landmarks**: Semantic HTML structure
- **Focus indicators**: Keyboard navigation visibility

### WCAG 2.2 Level AA Criteria Covered

- 1.1.1 Non-text Content
- 1.3.1 Info and Relationships
- 1.3.2 Meaningful Sequence
- 1.4.3 Contrast (Minimum)
- 2.4.1 Bypass Blocks
- 2.4.6 Headings and Labels
- 2.4.7 Focus Visible
- 3.2.4 Consistent Identification
- 3.3.2 Labels or Instructions
- 4.1.2 Name, Role, Value

## Project Structure

```
.
├── src/
│   ├── mastra/
│   │   └── index.ts          # Mastra agent & Stagehand tools
│   └── scripts/
│       └── audit.ts           # CLI audit script
├── reports/                   # Generated audit reports
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Advanced Usage

### Using BrowserBase (Cloud Execution)

1. Update `.env`:
```bash
STAGEHAND_ENV=BROWSERBASE
BROWSERBASE_API_KEY=your_api_key
BROWSERBASE_PROJECT_ID=your_project_id
```

2. Uncomment BrowserBase config in `src/mastra/index.ts`:
```typescript
stagehandInstance = new Stagehand({
  env: 'BROWSERBASE',
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID,
  verbose: 1,
  debugDom: true,
});
```

### Customizing the Agent

The agent's behavior is controlled by the system prompt in `src/mastra/index.ts`. You can:

- Add more WCAG criteria to check
- Adjust severity thresholds
- Customize the output format
- Add additional tools for specific checks

## License

MIT

## Contributing

Contributions welcome! This is an MVP - there's plenty of room for enhancement.

## Important Notes

- This tool augments, not replaces, manual accessibility testing
- AI may occasionally miss issues or produce false positives
- Always validate fixes with real assistive technology users
- Combine with axe, WAVE, and manual testing for comprehensive coverage
