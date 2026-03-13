import { config } from 'dotenv';
config({ path: '.env.prod' });
config({ path: '.env.local' });
config({ path: '.env' });

import { extractCampDataFromUrl } from '@/lib/ingestion/llm-extractor';

const url = process.argv[2] ?? 'https://aurorasbestsummercamp.com/';
const name = process.argv[3] ?? 'Best Kids Camp Aurora';

extractCampDataFromUrl(url, name).then(r => {
  console.log('Model:', r.model);
  console.log('Error:', r.error);
  console.log('Confidence:', JSON.stringify(r.confidence, null, 2));
  console.log('Extracted:', JSON.stringify(r.extracted, null, 2));
  console.log('Excerpts:', JSON.stringify(r.excerpts, null, 2));
}).catch(console.error);
