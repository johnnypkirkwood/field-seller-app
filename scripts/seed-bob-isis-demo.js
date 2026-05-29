// One-shot seed for the post-visit demo (M4a).
// Creates: Isis Toyota Account, Bob Isis Contact, Isis Toyota Opportunity,
// "June 17th Phillies Executive Outing" Campaign.
// Assigns Account + Opportunity owner to the demo rep (johnny).
//
// Safe to re-run: each create is guarded by an existence check.

const { sfCreate, sfQuery } = require('../sf');

const REP_USER_ID = '005Hs00000Ie1mpIAB';

async function findOne(soql) {
  const r = sfQuery(soql);
  return r.records[0] || null;
}

async function ensureAccount() {
  const existing = await findOne(
    `SELECT Id, Name FROM Account WHERE Name = 'Isis Toyota' LIMIT 1`
  );
  if (existing) {
    console.log(`SKIP Account     Isis Toyota already exists (${existing.Id})`);
    return existing.Id;
  }
  const res = await sfCreate('Account', {
    Name: 'Isis Toyota',
    OwnerId: REP_USER_ID,
    Phone: '(650) 555-0142',
    Website: 'https://isistoyota.example',
    Industry: 'Automotive',
    BillingStreet: '1500 California Dr',
    BillingCity: 'Burlingame',
    BillingState: 'CA',
    BillingPostalCode: '94010',
    BillingCountry: 'USA',
    ShippingStreet: '1500 California Dr',
    ShippingCity: 'Burlingame',
    ShippingState: 'CA',
    ShippingPostalCode: '94010',
    ShippingCountry: 'USA',
  });
  console.log(`OK   Account     Isis Toyota → ${res.id}`);
  return res.id;
}

async function ensureContact(accountId) {
  const existing = await findOne(
    `SELECT Id, FirstName, LastName, AccountId FROM Contact
       WHERE FirstName = 'Bob' AND LastName = 'Isis' LIMIT 1`
  );
  if (existing) {
    console.log(`SKIP Contact     Bob Isis already exists (${existing.Id})`);
    return existing.Id;
  }
  const res = await sfCreate('Contact', {
    FirstName: 'Bob',
    LastName: 'Isis',
    AccountId: accountId,
    Title: 'General Manager',
    Email: 'bob@isistoyota.example',
    Phone: '(650) 555-0143',
    MailingStreet: '1500 California Dr',
    MailingCity: 'Burlingame',
    MailingState: 'CA',
    MailingPostalCode: '94010',
    MailingCountry: 'USA',
  });
  console.log(`OK   Contact     Bob Isis → ${res.id}`);
  return res.id;
}

async function ensureOpportunity(accountId) {
  const existing = await findOne(
    `SELECT Id, Name, CloseDate FROM Opportunity
       WHERE AccountId = '${accountId}' AND Name = 'Isis Toyota — Q3 Fleet' LIMIT 1`
  );
  if (existing) {
    console.log(`SKIP Opportunity Isis Toyota — Q3 Fleet already exists (${existing.Id})`);
    return existing.Id;
  }
  const res = await sfCreate('Opportunity', {
    Name: 'Isis Toyota — Q3 Fleet',
    AccountId: accountId,
    OwnerId: REP_USER_ID,
    StageName: 'Negotiation',
    Amount: 185000,
    CloseDate: '2026-09-30',
    Description: 'Fleet refresh discussion with Bob Isis. Targeting Q3 close.',
  });
  console.log(`OK   Opportunity Isis Toyota — Q3 Fleet → ${res.id}`);
  return res.id;
}

async function ensureCampaign() {
  const existing = await findOne(
    `SELECT Id, Name FROM Campaign WHERE Name = 'June 17th Phillies Executive Outing' LIMIT 1`
  );
  if (existing) {
    console.log(`SKIP Campaign    Phillies Executive Outing already exists (${existing.Id})`);
    return existing.Id;
  }
  const res = await sfCreate('Campaign', {
    Name: 'June 17th Phillies Executive Outing',
    Type: 'Conference',
    Status: 'In Progress',
    IsActive: true,
    StartDate: '2026-06-17',
    EndDate: '2026-06-17',
    Description: 'Executive hospitality outing at Phillies vs Giants, Oracle Park.',
  });
  console.log(`OK   Campaign    Phillies Executive Outing → ${res.id}`);
  return res.id;
}

(async () => {
  try {
    const accountId  = await ensureAccount();
    const contactId  = await ensureContact(accountId);
    const oppId      = await ensureOpportunity(accountId);
    const campaignId = await ensureCampaign();

    console.log('\n--- verification ---');
    const verify = sfQuery(
      `SELECT Id, Name, BillingCity FROM Account WHERE Id = '${accountId}'`
    );
    console.log('Account:    ', verify.records[0]);

    const c = sfQuery(
      `SELECT Id, FirstName, LastName, Title, Account.Name FROM Contact WHERE Id = '${contactId}'`
    );
    console.log('Contact:    ', c.records[0]);

    const o = sfQuery(
      `SELECT Id, Name, StageName, Amount, CloseDate, Account.Name FROM Opportunity WHERE Id = '${oppId}'`
    );
    console.log('Opportunity:', o.records[0]);

    const cam = sfQuery(
      `SELECT Id, Name, Type, Status, IsActive, StartDate FROM Campaign WHERE Id = '${campaignId}'`
    );
    console.log('Campaign:   ', cam.records[0]);

    console.log('\nDone.');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  }
})();
