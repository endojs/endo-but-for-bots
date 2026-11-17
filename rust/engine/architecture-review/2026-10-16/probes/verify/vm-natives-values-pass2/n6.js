const f=(tz,t)=>new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'numeric',timeZone:tz,timeZoneName:'short'}).format(new Date(t));
const r=[f('America/New_York','2024-07-01T12:00Z'), f('America/New_York','2024-01-01T12:00Z'), Temporal.ZonedDateTime.from('2024-07-01T12:00[America/New_York]').offset];
let e; try{Temporal.ZonedDateTime.from('2024-07-01T12:00-04:00[America/New_York]')}catch(x){e=String(x)} r.push(e);
throw new Error(JSON.stringify(r));
