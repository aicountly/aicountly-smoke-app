import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyMentionsCompany,
  hasEmptyCompanyCopy,
  isCompanyRowText,
  isDuplicateCompanyError,
  isEmptyCompanyWorkspace,
  looksLikeCompanyPicker,
  readCompanyCount,
} from './companyPicker.js';

/** The HRMS picker as it renders with one company, panels and stat tiles included. */
const HRMS_PICKER_WITH_ONE = [
  'Welcome back, CA Rahul!',
  'Select a company to continue working in HRMS',
  'Search companies by name, code or GSTIN...',
  'Filters',
  'TOTAL COMPANIES 1',
  'ACTIVE COMPANIES 1',
  'YOUR STARRED 0',
  'LAST OPENED Nothing yet',
  'ADD COMPANY Create New Company',
  'Default Company',
  'Star a company below to set it as your default for quick access.',
  'Recently Opened',
  'Companies you open will appear here.',
  'All Companies (1)',
  'Sort by: Recently Used',
  'TC Test Co Test Co • 01-04-2026 -- 31-03-2027',
  'Showing 1 to 1 of 1',
].join('\n');

describe('companyPicker heuristics', () => {
  it('detects HRMS empty copy "No Companies yet!"', () => {
    assert.equal(hasEmptyCompanyCopy('No Companies yet!\nCreate New Company'), true);
  });

  it('detects manage empty copy "No companies found"', () => {
    assert.equal(
      hasEmptyCompanyCopy('No companies found. Create your first company to get started.'),
      true,
    );
  });

  it('does not treat a populated company list as empty', () => {
    assert.equal(hasEmptyCompanyCopy('Companies\nSmoke Test Co\nEdit'), false);
  });

  it('recognizes picker URLs and empty-state body text', () => {
    assert.equal(looksLikeCompanyPicker('https://hrms.aicountly.com/company', 'Welcome'), true);
    assert.equal(
      looksLikeCompanyPicker('https://manage.aicountly.com/#/fy', 'No companies found'),
      true,
    );
    assert.equal(
      looksLikeCompanyPicker('https://hrms.aicountly.com/dashboard', 'Attendance calendar'),
      false,
    );
  });

  it('matches the created company name case-insensitively', () => {
    assert.equal(bodyMentionsCompany('Opened Smoke Test Co workspace', 'smoke test co'), true);
    assert.equal(bodyMentionsCompany('No Companies yet!', 'Smoke Test Co'), false);
  });
});

describe('readCompanyCount', () => {
  it('reads the count the picker prints about itself', () => {
    assert.equal(readCompanyCount(HRMS_PICKER_WITH_ONE), 1);
    assert.equal(readCompanyCount('All Companies (2)\nSmoke Test Co\nTest Co'), 2);
    assert.equal(readCompanyCount('All Companies (0)'), 0);
  });

  it('is null when the picker never states a count', () => {
    assert.equal(readCompanyCount('Companies\nTest Co\nEdit'), null);
  });

  it('does not let a zeroed tile cancel out a populated list', () => {
    assert.equal(readCompanyCount('YOUR STARRED 0\nAll Companies (2)'), 2);
  });
});

describe('isEmptyCompanyWorkspace', () => {
  it('trusts the printed count over placeholder panel copy', () => {
    // "Companies you open will appear here" sits on a populated picker too. Reading
    // it as an empty workspace is what sent the run at a duplicate create.
    assert.equal(isEmptyCompanyWorkspace(HRMS_PICKER_WITH_ONE), false);
  });

  it('is empty when the picker says it lists none', () => {
    assert.equal(isEmptyCompanyWorkspace('All Companies (0)\nCreate New Company'), true);
  });

  it('falls back to empty-state copy when no count is printed', () => {
    assert.equal(isEmptyCompanyWorkspace('No Companies yet!\nCreate New Company'), true);
    assert.equal(isEmptyCompanyWorkspace('Companies\nTest Co'), false);
  });
});

describe('isCompanyRowText', () => {
  it('accepts a company row', () => {
    assert.equal(isCompanyRowText('Test Co Test Co • 01-04-2026 -- 31-03-2027'), true);
    assert.equal(isCompanyRowText('Smoke Test Co'), true);
  });

  it('rejects picker chrome, tiles and placeholders', () => {
    for (const chrome of [
      'Dashboard',
      'Invitations',
      'Financial Years',
      'Help & Support',
      'Chat with AI Buddy',
      'Create New Company',
      'All Companies (1)',
      'Sort by: Recently Used',
      'Showing 1 to 1 of 1',
      'TOTAL COMPANIES 1',
      'Star a company below to set it as your default for quick access.',
      'Companies you open will appear here.',
      'Nothing yet',
      'Recently Opened',
      'Welcome back, CA Rahul!',
      'TC',
      '1',
    ]) {
      assert.equal(isCompanyRowText(chrome), false, chrome);
    }
  });
});

describe('isDuplicateCompanyError', () => {
  it('reads the target rejecting the name as proof it is already there', () => {
    assert.equal(isDuplicateCompanyError(['You already have a company with this name', '*']), true);
    assert.equal(isDuplicateCompanyError(['Company name already exists.']), true);
  });

  it('does not treat an unrelated validation error as a duplicate', () => {
    assert.equal(isDuplicateCompanyError(['PIN code is required']), false);
    assert.equal(isDuplicateCompanyError([]), false);
  });
});
