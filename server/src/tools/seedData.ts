import { pool } from '../lib/pg.js';

type SeedOptions = {
  days: number;
  site: string;
  userEmail: string;
  userName: string;
  userId: number;
  includeValidated: boolean;
};

/** yyyy-mm-dd */
function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

function n(min: number, max: number) {
  return Math.round(min + Math.random() * (max - min));
}

function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)];
}

function sumRollup(
  rollup: Record<string, Record<string, Record<string, number>>>,
  activity: string,
  sub: string,
  metrics: Record<string, any>,
) {
  if (!rollup[activity]) rollup[activity] = {};
  if (!rollup[activity][sub]) rollup[activity][sub] = {};
  for (const [k, v] of Object.entries(metrics)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    rollup[activity][sub][k] = (rollup[activity][sub][k] || 0) + v;
  }
}


function buildMetaJson(acts: {activity:string; sub:string; values:any}[]) {
  const meta: any = {};
  const add = (act: string, sub: string, key: string, val: any) => {
    if (val == null) return;
    const s = String(val).trim();
    if (!s || s === '-') return;
    if (!meta[act]) meta[act] = {};
    if (!meta[act][sub]) meta[act][sub] = {};
    if (!meta[act][sub][key]) meta[act][sub][key] = [];
    if (!meta[act][sub][key].includes(s)) meta[act][sub][key].push(s);
  };
  for (const a of acts || []) {
    const act = a.activity;
    const sub = a.sub || '(No Sub Activity)';
    const v = a.values || {};
    add(act, sub, 'Sources', v.Source ?? v.source);
    add(act, sub, 'Locations', v.Location ?? v.location);
    add(act, sub, 'From', v.From ?? v.from);
    add(act, sub, 'To', v.To ?? v.to);
    add(act, sub, 'Materials', v.Material ?? v.material);
    add(act, sub, 'Equipment', v.Equipment ?? v.equipment ?? v.equipment_id);
  }
  return meta;
}

export async function seedData(opts: SeedOptions) {
  const days = Math.max(1, Math.min(365, Math.floor(opts.days || 60)));
  const site = String(opts.site || '').trim() || 'Test';
  const user_email = String(opts.userEmail || '').trim();
  const user_name = String(opts.userName || '').trim() || 'User';
  const user_id = Number(opts.userId || 0);
  const includeValidated = !!opts.includeValidated;

  if (!user_id || !user_email) {
    throw new Error('seedData: missing user context (userId/userEmail)');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const today = new Date();

    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);

      const dn = i % 2 === 0 ? 'DS' : 'NS';

      // Realistic subset: alternate "production-style" vs "development-style" days
      const isProductionDay = i % 3 !== 0; // 2/3 production, 1/3 development

      
      const rollup: Record<string, Record<string, Record<string, number>>> = {};
      const acts: Array<{ activity: string; sub: string; values: Record<string, any> }> = [];

      function setRollup(activity: string, sub: string, metrics: Record<string, number>) {
        if (!rollup[activity]) rollup[activity] = {};
        rollup[activity][sub] = metrics;
      }

      function addAct(activity: string, sub: string, values: Record<string, any>, totals: Record<string, number>) {
        acts.push({ activity, sub, values });
        setRollup(activity, sub, totals);
      }

      // ---------- HAULING ----------
      const prodTrucks = isProductionDay ? n(12, 30) : n(0, 8);
      const devTrucks = isProductionDay ? n(0, 6) : n(4, 14);

      const prodWeight = pick([40, 45, 50, 55]);
      const devWeight = pick([35, 40, 45, 50]);

      const prodDist = n(3, 12);
      const devDist = n(3, 10);

      const prodTkms = prodTrucks * prodWeight * prodDist;
      const devTkms = devTrucks * devWeight * devDist;

      if (prodTrucks > 0) {
        addAct(
          'Hauling',
          'Production',
          { Trucks: prodTrucks, Weight: prodWeight, Distance: prodDist, TKMs: prodTkms },
          { TKMs: prodTkms, Trucks: prodTrucks, Weight: prodWeight, Distance: prodDist },
        );
      }
      if (devTrucks > 0) {
        addAct(
          'Hauling',
          'Development',
          { Trucks: devTrucks, Weight: devWeight, Distance: devDist, TKMs: devTkms },
          { TKMs: devTkms, Trucks: devTrucks, Weight: devWeight, Distance: devDist },
        );
      }

      // Shift totals for ore/waste trucks (validate expects this exact nesting)
      const totalTrucks = prodTrucks + devTrucks;
      const wasteTrucks = totalTrucks === 0 ? 0 : n(0, Math.min(5, totalTrucks));
      const oreTrucks = Math.max(0, totalTrucks - wasteTrucks);
      setRollup('Hauling', 'Shift Totals', { Ore: oreTrucks, Waste: wasteTrucks });

      // Ensure both hauling subs exist with stable keys
      if (!rollup['Hauling']) rollup['Hauling'] = {};
      if (!rollup['Hauling']['Production']) rollup['Hauling']['Production'] = { TKMs: 0, Trucks: 0, Weight: 0, Distance: 0 };
      if (!rollup['Hauling']['Development']) rollup['Hauling']['Development'] = { TKMs: 0, Trucks: 0, Weight: 0, Distance: 0 };

      // ---------- LOADING ----------
      const stopeToSP = isProductionDay ? n(0, 20) : n(0, 6);
      const stopeSPtoSP = isProductionDay ? n(0, 8) : 0;
      const stopeToTruck = isProductionDay ? n(30, 90) : n(0, 10);
      const stopeSPtoTruck = isProductionDay ? n(0, 30) : 0;

      const devSPtoSP = !isProductionDay ? n(0, 10) : n(0, 4);
      const headingToSP = !isProductionDay ? n(0, 6) : 0;
      const devSPtoTruck = !isProductionDay ? n(5, 40) : n(0, 6);
      const headingToTruck = !isProductionDay ? n(10, 40) : n(0, 10);

      if (isProductionDay) {
        addAct(
          'Loading',
          'Production',
          {
            'Stope to SP': stopeToSP,
            'Stope SP to SP': stopeSPtoSP,
            'Stope to Truck': stopeToTruck,
            'Stope SP to Truck': stopeSPtoTruck,
          },
          {
            'Stope to SP': stopeToSP,
            'Stope SP to SP': stopeSPtoSP,
            'Stope to Truck': stopeToTruck,
            'Stope SP to Truck': stopeSPtoTruck,
          },
        );
      } else {
        addAct(
          'Loading',
          'Development',
          {
            'Dev SP to SP': devSPtoSP,
            'Heading to SP': headingToSP,
            'Dev SP to Truck': devSPtoTruck,
            'Heading to Truck': headingToTruck,
          },
          {
            'Dev SP to SP': devSPtoSP,
            'Heading to SP': headingToSP,
            'Dev SP to Truck': devSPtoTruck,
            'Heading to Truck': headingToTruck,
          },
        );
      }

      // Always include the opposite bucket group as zeros so UI totals have stable keys
      if (!rollup['Loading']) rollup['Loading'] = {};
      if (!rollup['Loading']['Production'])
        rollup['Loading']['Production'] = {
          'Stope to SP': 0,
          'Stope SP to SP': 0,
          'Stope to Truck': 0,
          'Stope SP to Truck': 0,
        };
      if (!rollup['Loading']['Development'])
        rollup['Loading']['Development'] = {
          'Dev SP to SP': 0,
          'Heading to SP': 0,
          'Dev SP to Truck': 0,
          'Heading to Truck': 0,
        };

      // ---------- CHARGING ----------
      const prodChargeKg = isProductionDay ? n(600, 1800) : n(0, 400);
      const prodHoles = isProductionDay ? n(40, 140) : n(0, 20);
      const prodTonnesFired = isProductionDay ? n(1200, 6000) : 0;
      const prodChargeMetres = isProductionDay ? n(200, 900) : n(0, 120);

      const devChargeKg = !isProductionDay ? n(150, 450) : n(0, 150);
      const devCutLen = 4; // consistent with your examples
      const devHoles = !isProductionDay ? n(40, 90) : n(0, 20);
      const devChargeMetres = !isProductionDay ? n(120, 450) : n(0, 120);

      if (prodChargeKg > 0 || prodHoles > 0 || prodChargeMetres > 0) {
        addAct(
          'Charging',
          'Production',
          {
            'Charge kg': prodChargeKg,
            'No of Holes': prodHoles,
            'Tonnes Fired': prodTonnesFired,
            'Charge Metres': prodChargeMetres,
          },
          {
            'Charge kg': prodChargeKg,
            'No of Holes': prodHoles,
            'Tonnes Fired': prodTonnesFired,
            'Charge Metres': prodChargeMetres,
          },
        );
      }
      if (devChargeKg > 0 || devHoles > 0 || devChargeMetres > 0) {
        addAct(
          'Charging',
          'Development',
          {
            'Charge kg': devChargeKg,
            'Cut Length': devCutLen,
            'No of Holes': devHoles,
            'Charge Metres': devChargeMetres,
          },
          {
            'Charge kg': devChargeKg,
            'Cut Length': devCutLen,
            'No of Holes': devHoles,
            'Charge Metres': devChargeMetres,
          },
        );
      }

      // Ensure both subs exist with stable keys
      if (!rollup['Charging']) rollup['Charging'] = {};
      if (!rollup['Charging']['Production'])
        rollup['Charging']['Production'] = {
          'Charge kg': 0,
          'No of Holes': 0,
          'Tonnes Fired': 0,
          'Charge Metres': 0,
        };
      if (!rollup['Charging']['Development'])
        rollup['Charging']['Development'] = {
          'Charge kg': 0,
          'Cut Length': 4,
          'No of Holes': 0,
          'Charge Metres': 0,
        };

      // ---------- HOISTING ----------
      const oreTonnes = isProductionDay ? n(600, 2200) : n(200, 1200);
      const wasteTonnes = n(0, 600);
      addAct(
        'Hoisting',
        '(No Sub Activity)',
        { 'Ore Tonnes': oreTonnes, 'Waste Tonnes': wasteTonnes },
        { 'Ore Tonnes': oreTonnes, 'Waste Tonnes': wasteTonnes },
      );

      // ---------- DEVELOPMENT (subset on dev-style days) ----------
      if (!rollup['Development']) rollup['Development'] = {};

      if (!isProductionDay) {
        // Face Drilling
        const faceCutLen = 4;
        const faceHoles = n(30, 80);
        const devDrillm = faceHoles * faceCutLen;
        const reamers = n(0, 8);

        addAct(
          'Development',
          'Face Drilling',
          {
            'Cut Length': faceCutLen,
            'No of Holes': faceHoles,
            'Dev Drillm': devDrillm,
            'No of Reamers': reamers,
          },
          {
            'Cut Length': faceCutLen,
            'No of Holes': faceHoles,
            'Dev Drillm': devDrillm,
            'No of Reamers': reamers,
          },
        );

        // Ground Support
        const boltLen = pick([2.4, 3, 4, 5, 6]);
        const bolts = n(20, 70);
        const gsDrillm = Math.round(bolts * boltLen);
        const agiVol = n(0, 6);
        const sprayVol = n(0, 6);

        addAct(
          'Development',
          'Ground Support',
          {
            'Bolt Length': boltLen,
            'No. of Bolts': bolts,
            'GS Drillm': gsDrillm,
            'Agi Volume': agiVol,
            'Spray Volume': sprayVol,
          },
          {
            'GS Drillm': gsDrillm,
            'Agi Volume': agiVol,
            'Bolt Length': boltLen,
            'No. of Bolts': bolts,
            'Spray Volume': sprayVol,
          },
        );

        // Rehab (sometimes)
        if (Math.random() < 0.5) {
          const rBoltLen = pick([3, 4, 5, 6]);
          const rBolts = n(20, 90);
          const rGs = Math.round(rBolts * rBoltLen);
          const rAgi = n(0, 8);
          const rSpray = n(0, 8);

          addAct(
            'Development',
            'Rehab',
            {
              'Bolt Length': rBoltLen,
              'No. of Bolts': rBolts,
              'GS Drillm': rGs,
              'Agi Volume': rAgi,
              'Spray Volume': rSpray,
            },
            {
              'GS Drillm': rGs,
              'Agi Volume': rAgi,
              'Bolt Length': rBoltLen,
              'No. of Bolts': rBolts,
              'Spray Volume': rSpray,
            },
          );
        }
      } else {
        // production-style day: keep dev groups present but zeroed (for stable display)
        rollup['Development']['Rehab'] =
          rollup['Development']['Rehab'] || { 'GS Drillm': 0, 'Agi Volume': 0, 'Bolt Length': 0, 'No. of Bolts': 0, 'Spray Volume': 0 };
        rollup['Development']['Face Drilling'] =
          rollup['Development']['Face Drilling'] || { 'Cut Length': 4, 'Dev Drillm': 0, 'No of Holes': 0, 'No of Reamers': 0 };
        rollup['Development']['Ground Support'] =
          rollup['Development']['Ground Support'] || { 'GS Drillm': 0, 'Agi Volume': 0, 'Bolt Length': 0, 'No. of Bolts': 0, 'Spray Volume': 0 };
      }

      // ---------- PRODUCTION DRILLING ----------
      if (!rollup['Production Drilling']) rollup['Production Drilling'] = {};
      if (isProductionDay) {
        const stRedrills = n(0, 30);
        const stMetres = n(80, 260);
        const stClean = n(0, 40);
        addAct(
          'Production Drilling',
          'Stope',
          { Redrills: stRedrills, 'Metres Drilled': stMetres, 'Cleanouts Drilled': stClean },
          { Redrills: stRedrills, 'Metres Drilled': stMetres, 'Cleanouts Drilled': stClean },
        );

        const svRedrills = n(0, 10);
        const svMetres = n(80, 260);
        const svClean = n(0, 50);
        addAct(
          'Production Drilling',
          'Service Hole',
          { Redrills: svRedrills, 'Metres Drilled': svMetres, 'Cleanouts Drilled': svClean },
          { Redrills: svRedrills, 'Metres Drilled': svMetres, 'Cleanouts Drilled': svClean },
        );
      } else {
        rollup['Production Drilling']['Stope'] =
          rollup['Production Drilling']['Stope'] || { Redrills: 0, 'Metres Drilled': 0, 'Cleanouts Drilled': 0 };
        rollup['Production Drilling']['Service Hole'] =
          rollup['Production Drilling']['Service Hole'] || { Redrills: 0, 'Metres Drilled': 0, 'Cleanouts Drilled': 0 };
      }
      // meta_json is used for dropdowns (Sources/Locations/Equipment/Material etc.)
      // and must be stored alongside totals_json for reporting/validation UI.
      const metaJson = buildMetaJson(acts);

      const shiftRes = await client.query(
        `INSERT INTO shifts (user_id, user_email, user_name, site, date, dn, totals_json, meta_json, updated_at, finalized_at)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7::jsonb,$8::jsonb, now(), now())
         ON CONFLICT (user_id, date, dn)
         DO UPDATE SET user_email=EXCLUDED.user_email,
                       user_name=EXCLUDED.user_name,
                       site=EXCLUDED.site,
                       totals_json=EXCLUDED.totals_json,
                       meta_json=EXCLUDED.meta_json,
                       finalized_at=EXCLUDED.finalized_at,
                       updated_at=EXCLUDED.updated_at
         RETURNING id`,
        [user_id, user_email, user_name, site, ymd(d), dn, JSON.stringify(rollup), JSON.stringify(metaJson)],
      );
      const shift_id = shiftRes.rows[0].id as number;

      // Replace existing activities for this shift
      await client.query(`DELETE FROM shift_activities WHERE shift_id=$1`, [shift_id]);

      for (const a of acts) {
        const payload = { sub: a.sub, values: a.values };
        await client.query(
          `INSERT INTO shift_activities (shift_id, user_email, user_name, site, activity, sub_activity, payload_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [shift_id, user_email, user_name, site, a.activity, a.sub, JSON.stringify(payload)],
        );
      }

      if (includeValidated) {
        // Replace validated shift for this date/dn/user
        const vs = await client.query(
          `DELETE FROM validated_shifts
             WHERE site=$1 AND COALESCE(user_email,'')=COALESCE($2,'') AND date=$3::date AND dn=$4`,
          [site, user_email, ymd(d), dn],
        );

	        const vShiftRes = await client.query(
	          `INSERT INTO validated_shifts (site, date, dn, user_email, user_name, validated, totals_json)
	           VALUES ($1,$2::date,$3,COALESCE($4,''),$5,0,$6::jsonb)
	           RETURNING id`,
	          [site, ymd(d), dn, user_email, user_name, JSON.stringify(rollup)],
	        );
        const v_shift_id = vShiftRes.rows[0].id as number;

        // validated_shift_activities is keyed by (site,date,dn,user_email) in this schema
        await client.query(
          `DELETE FROM validated_shift_activities
            WHERE site=$1 AND date=$2::date AND dn=$3 AND COALESCE(user_email,'')=COALESCE($4,'')`,
          [site, ymd(d), dn, user_email],
        );

        for (const a of acts) {
          const payload = { sub: a.sub, values: a.values };
          await client.query(
            `INSERT INTO validated_shift_activities (site, date, dn, user_email, user_name, activity, sub_activity, payload_json)
             VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8::jsonb)`,
            [site, ymd(d), dn, user_email, user_name, a.activity, a.sub, JSON.stringify(payload)],
          );
        }

      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { ok: true, site, days, includeValidated };

}

