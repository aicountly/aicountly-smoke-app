import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bodyMentionsCompany, hasEmptyCompanyCopy, looksLikeCompanyPicker } from './companyPicker.js';

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
