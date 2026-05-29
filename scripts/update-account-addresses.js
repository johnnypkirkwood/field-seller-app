const { sfUpdate, sfQuery } = require('../sf');

const MAPPING = [
  { id: '001Hs00005w9HWyIAM', name: 'Valley Supply Inc.',      street: '3910 24th St',          city: 'San Francisco',       state: 'CA', postalCode: '94114' },
  { id: '001Hs00005w9HVtIAM', name: 'Haven Enterprises',       street: '183 Victoria St',       city: 'San Francisco',       state: 'CA', postalCode: '94132' },
  { id: '001Hs00005w9HVWIA2', name: 'Advanced Communications', street: '50 Persia Ave',         city: 'San Francisco',       state: 'CA', postalCode: '94112' },
  { id: '001Hs00005w9HVVIA2', name: 'Act on Software',         street: '200 San Pedro Rd',      city: 'Daly City',           state: 'CA', postalCode: '94014' },
  { id: '001Hs00005w9HVoIAM', name: 'Employnet',               street: '128 Brentwood Dr',      city: 'South San Francisco', state: 'CA', postalCode: '94080' },
  { id: '001Hs00005w9HWYIA2', name: 'Omega Insurance',         street: '1486 El Camino Real',   city: 'San Bruno',           state: 'CA', postalCode: '94066' },
  { id: '001Hs00005w9HVrIAM', name: 'Gusto Manufacturing',     street: '1395 Marsten Rd',       city: 'Burlingame',          state: 'CA', postalCode: '94010' },
  { id: '001Hs00005w9HWuIAM', name: 'Universal Containers',    street: '852 N Delaware St',     city: 'San Mateo',           state: 'CA', postalCode: '94401' },
  { id: '001Hs00005w9HWjIAM', name: 'Proofpoint',              street: '1060 Park Pl',          city: 'San Mateo',           state: 'CA', postalCode: '94403' },
  { id: '001Hs00005w9HWaIAM', name: 'Omega Technologies',      street: '1304 W Hillsdale Blvd', city: 'San Mateo',           state: 'CA', postalCode: '94403' },
];

(async () => {
  for (const a of MAPPING) {
    try {
      await sfUpdate('Account', a.id, {
        BillingStreet:      a.street,
        BillingCity:        a.city,
        BillingState:       a.state,
        BillingPostalCode:  a.postalCode,
        ShippingStreet:     a.street,
        ShippingCity:       a.city,
        ShippingState:      a.state,
        ShippingPostalCode: a.postalCode,
      });
      console.log(`OK   ${a.name} → ${a.street}, ${a.city}`);
    } catch (err) {
      console.error(`FAIL ${a.name}: ${err.message}`);
      process.exitCode = 1;
    }
  }

  console.log('\n--- verification ---');
  const ids = MAPPING.map(a => `'${a.id}'`).join(',');
  const result = sfQuery(
    `SELECT Name, BillingStreet, BillingCity, BillingState, BillingPostalCode FROM Account WHERE Id IN (${ids}) ORDER BY Name`
  );
  for (const r of result.records) {
    console.log(`${r.Name.padEnd(28)} | ${(r.BillingStreet || '').padEnd(28)} | ${r.BillingCity}, ${r.BillingState} ${r.BillingPostalCode || ''}`);
  }
})();
