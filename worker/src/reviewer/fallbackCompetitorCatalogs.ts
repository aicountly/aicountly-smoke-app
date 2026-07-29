import type { CompetitorBenchmark } from './featureGapEngine.js';
import { canonicalProduct } from './productAliases.js';

/** Bundled competitor catalogs (from samples/competitors). Used when API has none. */
const CATALOGS: Record<string, CompetitorBenchmark[]> = {
  "auditor": [
    {
      "product_name": "auditor",
      "competitor_name": "CaseWare Cloud",
      "features": [
        "engagement letter",
        "risk assessment",
        "audit programs",
        "internal control testing",
        "sampling",
        "working papers",
        "review notes",
        "completion checklist",
        "trial balance",
        "lead schedules",
        "consolidation",
        "report writer"
      ],
      "source_url": "https://www.caseware.com"
    },
    {
      "product_name": "auditor",
      "competitor_name": "Wolters Kluwer Audit Management",
      "features": [
        "ai assistance",
        "issue tracking",
        "follow-ups",
        "compliance dashboards",
        "kyc",
        "risk scoring",
        "cloud collaboration"
      ],
      "source_url": "https://www.wolterskluwer.com"
    },
    {
      "product_name": "auditor",
      "competitor_name": "Suralink",
      "features": [
        "request list",
        "client portal",
        "document checklist",
        "due date tracking",
        "reminders",
        "audit trail"
      ],
      "source_url": "https://suralink.com"
    }
  ],
  "books": [
    {
      "product_name": "books",
      "competitor_name": "Tally Prime",
      "features": [
        "voucher entry",
        "ledger",
        "stock summary",
        "purchase orders",
        "sales orders",
        "gst returns",
        "e-invoice",
        "e-way bill",
        "bank reconciliation",
        "multi-currency",
        "multi-branch",
        "audit trail",
        "tds",
        "tcs",
        "fixed asset register",
        "budgets",
        "scenarios",
        "payroll module",
        "cost centres",
        "drill down",
        "remote access"
      ],
      "source_url": "https://tallysolutions.com"
    },
    {
      "product_name": "books",
      "competitor_name": "Zoho Books",
      "features": [
        "invoices",
        "estimates",
        "recurring invoices",
        "credit notes",
        "expenses",
        "vendor credits",
        "bills",
        "purchase orders",
        "bank reconciliation",
        "chart of accounts",
        "manual journals",
        "fixed assets",
        "budgeting",
        "project tracking",
        "time tracking",
        "client portal",
        "e-invoice",
        "gstr-1",
        "gstr-3b",
        "tds",
        "tcs",
        "multi currency",
        "branches",
        "audit trail",
        "api / webhooks"
      ],
      "source_url": "https://www.zoho.com/books"
    },
    {
      "product_name": "books",
      "competitor_name": "QuickBooks Online",
      "features": [
        "invoices",
        "estimates",
        "expenses",
        "bill pay",
        "bank feeds",
        "reconciliation",
        "chart of accounts",
        "journal entries",
        "fixed assets",
        "inventory",
        "purchase orders",
        "1099 / tds",
        "mileage tracking",
        "projects",
        "time tracking",
        "budgets",
        "audit log",
        "rule based categorisation",
        "mobile receipt scan"
      ],
      "source_url": "https://quickbooks.intuit.com"
    },
    {
      "product_name": "books",
      "competitor_name": "Busy Accounting",
      "features": [
        "voucher",
        "stock",
        "gst",
        "e-invoice",
        "e-way bill",
        "tds",
        "branch accounting",
        "production / bom",
        "broker management",
        "multi-godown",
        "trf inward outward",
        "reorder management"
      ],
      "source_url": "https://busy.in"
    }
  ],
  "buddy": [
    {
      "product_name": "buddy",
      "competitor_name": "Notion",
      "features": [
        "markdown import",
        "markdown export",
        "pdf export",
        "file attachments",
        "workspace export"
      ],
      "source_url": "https://www.notion.so"
    },
    {
      "product_name": "buddy",
      "competitor_name": "Confluence",
      "features": [
        "word import",
        "pdf export",
        "html export",
        "file attachments"
      ],
      "source_url": "https://www.atlassian.com/software/confluence"
    }
  ],
  "calendar": [
    {
      "product_name": "calendar",
      "competitor_name": "Google Calendar",
      "features": [
        "day view",
        "week view",
        "month view",
        "timezones",
        "recurring events",
        "rooms",
        "reminders",
        "shared calendars",
        "find a time",
        "tasks integration",
        "appointment slots",
        "rsvp",
        "out of office",
        "focus time",
        "meet integration"
      ],
      "source_url": "https://calendar.google.com"
    },
    {
      "product_name": "calendar",
      "competitor_name": "Reclaim.ai",
      "features": [
        "ai scheduling",
        "smart 1:1s",
        "habits",
        "tasks",
        "buffer time",
        "decompression time",
        "meeting analytics",
        "team availability"
      ],
      "source_url": "https://reclaim.ai"
    },
    {
      "product_name": "calendar",
      "competitor_name": "Sunsama",
      "features": [
        "daily planning",
        "task pull",
        "focus mode",
        "calendar sync",
        "weekly review",
        "team queue"
      ],
      "source_url": "https://sunsama.com"
    },
    {
      "product_name": "calendar",
      "competitor_name": "Motion",
      "features": [
        "ai planner",
        "auto reschedule",
        "deadline aware",
        "meeting booking",
        "project planning"
      ],
      "source_url": "https://www.usemotion.com"
    }
  ],
  "chat": [
    {
      "product_name": "chat",
      "competitor_name": "Slack",
      "features": [
        "file attachments",
        "drag and drop upload",
        "attachment preview",
        "attachment download",
        "search files"
      ],
      "source_url": "https://slack.com"
    },
    {
      "product_name": "chat",
      "competitor_name": "Microsoft Teams",
      "features": [
        "file upload",
        "file sharing",
        "document preview",
        "download attachments"
      ],
      "source_url": "https://www.microsoft.com/microsoft-teams"
    }
  ],
  "contacts": [
    {
      "product_name": "contacts",
      "competitor_name": "HubSpot CRM",
      "features": [
        "contacts",
        "companies",
        "deals",
        "tickets",
        "activities",
        "email sync",
        "calendar sync",
        "tasks",
        "lists / segments",
        "lead scoring",
        "duplicate management",
        "import / export",
        "mobile app",
        "automation",
        "snippets / templates"
      ],
      "source_url": "https://www.hubspot.com/products/crm"
    },
    {
      "product_name": "contacts",
      "competitor_name": "Pipedrive",
      "features": [
        "pipeline view",
        "deal probability",
        "activity reminders",
        "email sync",
        "duplicate detection",
        "smart contact data",
        "lead inbox",
        "products catalog"
      ],
      "source_url": "https://www.pipedrive.com"
    },
    {
      "product_name": "contacts",
      "competitor_name": "Zoho CRM",
      "features": [
        "leads",
        "accounts",
        "contacts",
        "deals",
        "campaigns",
        "workflows",
        "approvals",
        "blueprint",
        "ai assistant zia",
        "social integrations"
      ],
      "source_url": "https://www.zoho.com/crm"
    },
    {
      "product_name": "contacts",
      "competitor_name": "Folk",
      "features": [
        "groups",
        "tags",
        "interaction history",
        "linkedin enrichment",
        "shared address book"
      ],
      "source_url": "https://folk.app"
    }
  ],
  "docs": [
    {
      "product_name": "docs",
      "competitor_name": "Google Docs",
      "features": [
        "document upload",
        "pdf import",
        "pdf export",
        "docx export",
        "version history",
        "real-time collaboration"
      ],
      "source_url": "https://workspace.google.com/products/docs/"
    },
    {
      "product_name": "docs",
      "competitor_name": "Microsoft 365",
      "features": [
        "file upload",
        "pdf export",
        "docx import / export",
        "comments",
        "track changes"
      ],
      "source_url": "https://www.microsoft.com/microsoft-365"
    }
  ],
  "fr": [
    {
      "product_name": "fr",
      "competitor_name": "CaseWare Financials",
      "features": [
        "schedule iii",
        "ind-as",
        "notes library",
        "trial balance import",
        "consolidation",
        "comparatives",
        "cash flow",
        "xbrl export",
        "audit trail",
        "review hierarchy"
      ],
      "source_url": "https://www.caseware.com"
    },
    {
      "product_name": "fr",
      "competitor_name": "IRIS Carbon",
      "features": [
        "xbrl tagging",
        "esef",
        "ifrs taxonomy",
        "review notes",
        "version history",
        "anchored exports"
      ],
      "source_url": "https://iriscarbon.com"
    },
    {
      "product_name": "fr",
      "competitor_name": "DataSnipper",
      "features": [
        "ai extraction",
        "tickmarks",
        "reconciliation",
        "automation rules",
        "documentation linking"
      ],
      "source_url": "https://datasnipper.com"
    }
  ],
  "hrms": [
    {
      "product_name": "hrms",
      "competitor_name": "Keka",
      "features": [
        "employee directory",
        "attendance",
        "leave",
        "payroll",
        "form 16",
        "tds engine",
        "performance reviews",
        "okrs",
        "1:1 meetings",
        "expense claims",
        "travel",
        "engagement surveys",
        "exit checklist",
        "onboarding",
        "offer letter",
        "esignature",
        "asset management",
        "document vault",
        "hrms mobile app"
      ],
      "source_url": "https://www.keka.com"
    },
    {
      "product_name": "hrms",
      "competitor_name": "Zoho People",
      "features": [
        "employee profile",
        "leave tracker",
        "shift scheduler",
        "timesheet",
        "attendance regularization",
        "performance",
        "self-service portal",
        "case management",
        "training",
        "lms",
        "policy library",
        "goals & reviews",
        "approvals workflow"
      ],
      "source_url": "https://www.zoho.com/people"
    },
    {
      "product_name": "hrms",
      "competitor_name": "greytHR",
      "features": [
        "payroll",
        "statutory compliance",
        "income tax",
        "pf",
        "esi",
        "pt",
        "lwf",
        "gratuity",
        "form 24q",
        "form 16",
        "leave",
        "attendance",
        "self-service",
        "expense claims",
        "geo attendance"
      ],
      "source_url": "https://www.greythr.com"
    },
    {
      "product_name": "hrms",
      "competitor_name": "Darwinbox",
      "features": [
        "ai chatbot",
        "okrs",
        "talent acquisition",
        "lms",
        "succession planning",
        "rewards & recognition",
        "pulse surveys",
        "comp planning",
        "global payroll"
      ],
      "source_url": "https://darwinbox.com"
    }
  ],
  "my-account": [
    {
      "product_name": "my-account",
      "competitor_name": "Auth0 Account Center",
      "features": [
        "profile avatar upload",
        "image validation",
        "profile export",
        "account data download"
      ],
      "source_url": "https://auth0.com"
    },
    {
      "product_name": "my-account",
      "competitor_name": "Okta End-User Dashboard",
      "features": [
        "profile management",
        "avatar upload",
        "account data export"
      ],
      "source_url": "https://www.okta.com"
    }
  ],
  "ourpeople": [
    {
      "product_name": "ourpeople",
      "competitor_name": "BambooHR",
      "features": [
        "employee document upload",
        "document vault",
        "csv import",
        "excel export",
        "report export"
      ],
      "source_url": "https://www.bamboohr.com"
    },
    {
      "product_name": "ourpeople",
      "competitor_name": "HiBob",
      "features": [
        "employee files",
        "bulk document upload",
        "csv import",
        "report export"
      ],
      "source_url": "https://www.hibob.com"
    }
  ],
  "secretarial": [
    {
      "product_name": "secretarial",
      "competitor_name": "Suvit",
      "features": [
        "agenda",
        "minutes",
        "circular resolutions",
        "registers",
        "compliance calendar"
      ],
      "source_url": "https://suvit.io"
    },
    {
      "product_name": "secretarial",
      "competitor_name": "ComplianceMantra",
      "features": [
        "mca filings",
        "dir-3 kyc",
        "mgt-7",
        "aoc-4",
        "dpt-3",
        "msme-1",
        "compliance calendar",
        "statutory registers",
        "share transfer",
        "charges register",
        "dsc management"
      ],
      "source_url": "https://compliancemantra.in"
    },
    {
      "product_name": "secretarial",
      "competitor_name": "ResolutionPro",
      "features": [
        "agenda templates",
        "minutes builder",
        "ss-1 / ss-2 secretarial standards",
        "board portal",
        "e-voting"
      ],
      "source_url": "https://resolutionpro.in"
    }
  ],
  "vault": [
    {
      "product_name": "vault",
      "competitor_name": "1Password",
      "features": [
        "document vault",
        "file attachments",
        "secure file upload",
        "attachment download",
        "version history"
      ],
      "source_url": "https://1password.com"
    },
    {
      "product_name": "vault",
      "competitor_name": "Bitwarden",
      "features": [
        "encrypted file attachments",
        "secure export",
        "vault import",
        "vault export"
      ],
      "source_url": "https://bitwarden.com"
    }
  ]
};

export function fallbackCompetitorCatalogs(productName: string): CompetitorBenchmark[] {
  const key = (productName || '').trim().toLowerCase();
  return CATALOGS[canonicalProduct(key)] || CATALOGS[key] || [];
}
