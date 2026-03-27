/**
 * Run this once after deploying to seed your reps from FUB into Supabase.
 * Usage: node utils/seed-reps.js
 */
require('dotenv').config();
const { getUsers } = require('../db/followupboss');
const { supabase } = require('../db/supabase');

async function seedReps() {
  console.log('Fetching users from FollowUp Boss...');
  const fubUsers = await getUsers();

  // Filter to only your active sales reps
  // Customize this filter if needed (by role, team, name, etc.)
  const reps = fubUsers.filter(u => u.isActive && u.role !== 'admin');

  console.log(`Found ${reps.length} reps in FUB:`);
  reps.forEach(u => console.log(`  - ${u.name} (ID: ${u.id})`));

  for (const user of reps) {
    const { error } = await supabase
      .from('reps')
      .upsert({
        fub_user_id: String(user.id),
        name: user.name,
        email: user.email
      }, { onConflict: 'fub_user_id' });

    if (error) console.error(`Failed to upsert ${user.name}:`, error.message);
    else console.log(`✓ Seeded rep: ${user.name}`);
  }

  console.log('\nDone. Your reps are ready in Supabase.');
  process.exit(0);
}

seedReps().catch(e => { console.error(e); process.exit(1); });
