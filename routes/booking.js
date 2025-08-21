var express = require('express');
var router = express.Router();

var { body, validationResult } = require('express-validator');

var pool = require('./db')



// --- helpers (local-safe) ---
function toYMDLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function parseHM(hm) {
  const [h, m] = hm.split(':').map(Number);
  return { h: h||0, m: m||0 };
}
function formatHM(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/**
 * Generate slots in local time for a given date + range.
 * - dateISO: 'YYYY-MM-DD'
 * - startHM/endHM: 'HH:mm'
 * - isToday: boolean for *local* today
 * - intervalMin: slot interval (default 15)
 */
function genSlotsForRangeLocal(dateISO, startHM, endHM, isToday, intervalMin = 5) {
  const [y, mo, da] = dateISO.split('-').map(Number);
  const { h: sh, m: sm } = parseHM(startHM);
  const { h: eh, m: em } = parseHM(endHM);

  // Local start/end
  let cur = new Date(y, mo-1, da, sh, sm, 0, 0);
  const end = new Date(y, mo-1, da, eh, em, 0, 0);

  // If today: start from "now" (rounded up to interval)
  if (isToday) {
    const now = new Date();
    // Round up to next interval
    const rounded = new Date(now);
    const minutes = rounded.getMinutes();
    const remainder = minutes % intervalMin;
    if (remainder !== 0) rounded.setMinutes(minutes + (intervalMin - remainder), 0, 0);
    // Use the later of range-start vs rounded-now
    if (rounded > cur) cur = rounded;
  }

  const out = [];
  while (cur < end) {
    out.push(formatHM(cur));
    cur = new Date(cur.getTime() + intervalMin * 60000);
  }
  return out;
}


/* ---------- helpers ---------- */

function jsToDow1Mon(date) {
  // JS: 0=Sun..6=Sat  -> our schema: 1=Mon..7=Sun
  const d = date.getDay(); // 0..6
  return d === 0 ? 7 : d;  // Sun -> 7
}

function toTimeStr(date) {
  return date.toTimeString().slice(0,5); // HH:MM
}

function addMinutes(date, mins) {
  return new Date(date.getTime() + mins * 60000);
}

function ceilTo5(date) {
  const minutes = date.getMinutes();
  const mod = minutes % 5;
  if (mod === 0) return date;
  const diff = 5 - mod;
  const d = new Date(date);
  d.setMinutes(minutes + diff, 0, 0);
  return d;
}

/* Generate 5-min slots for a given range [start,end) in local time */
function genSlotsForRange(dateISO, startHHMM, endHHMM, isToday) {
  const [y,m,d] = dateISO.split('-').map(Number);
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);

  // Start as an exclusive LOWER bound for "now"
  let cur = new Date(y, m-1, d, sh, sm, 0, 0);
  const end = new Date(y, m-1, d, eh, em, 0, 0);

  if (isToday) {
    const now = new Date();
    // do not show past times; next available is ceil(now to 5)
    cur = ceilTo5(now);
  }

  // slots are the start instants every 5 minutes strictly before "end"
  const out = [];
  if (cur >= end) return out;

  // Align to 5-min grid with respect to range start
  if ((cur.getMinutes() % 5) !== 0) cur = ceilTo5(cur);

  while (cur < end) {
    out.push(toTimeStr(cur));
    cur = addMinutes(cur, 5);
  }
  return out;
}

/* Merge weekly hours + exception (if any) to produce 0..N ranges for a date */
async function getOpenRangesForDate(doctor_id, dateISO) {
  // Check exception first
  const [exRows] = await pool.query(
    `SELECT is_closed, start_time, end_time
       FROM doctor_exceptions
      WHERE doctor_id=? AND exception_date=?`,
    [doctor_id, dateISO]
  );
  if (exRows.length) {
    const ex = exRows[0];
    if (ex.is_closed) return [];                  // closed all day
    if (ex.start_time && ex.end_time) {
      return [{ start_time: ex.start_time, end_time: ex.end_time }]; // one special window
    }
    return []; // safety
  }

  // Otherwise weekly template
  const date = new Date(dateISO + 'T00:00:00');
  const dow = jsToDow1Mon(date);
  const [rows] = await pool.query(
    `SELECT start_time, end_time
       FROM doctor_open_hours
      WHERE doctor_id=? AND day_of_week=?
      ORDER BY slot_index`,
    [doctor_id, dow]
  );
  return rows; // array of {start_time, end_time}
}

/* Return available 5-min slots for a doctor and date (minus already-booked) */
async function getAvailableSlots(doctor_id, dateISO) {
  // LOCAL today check
  const isToday = (toYMDLocal(new Date()) === dateISO);

  const ranges = await getOpenRangesForDate(doctor_id, dateISO);
  // Load booked times (assumes 'HH:mm:ss' or 'HH:mm')
  const [booked] = await pool.query(
    `SELECT appointment_time FROM bookings
      WHERE doctor_id=? AND appointment_date=?`,
    [doctor_id, dateISO]
  );
  const bookedSet = new Set(
    booked.map(b => (b.appointment_time || '').slice(0,5))
  );

  // Build, flatten, de-duplicate, sort
  const uniq = new Set();
  for (const r of ranges) {
    const start = (r.start_time || '').slice(0,5);
    const end   = (r.end_time   || '').slice(0,5);
    if (!start || !end) continue;
    const list = genSlotsForRangeLocal(dateISO, start, end, isToday, 5);
    list.forEach(t => uniq.add(t));
  }

  // Remove already-booked, return sorted
  return Array.from(uniq)
    .filter(t => !bookedSet.has(t))
    .sort((a,b) => a.localeCompare(b)); // 'HH:mm' lexicographic works
}


/* ---------- pages ---------- */

/** Step 1: choose city */
router.get('/', async (req, res) => {
    console.log('patient',req.session.patient)
  const [cities] = await pool.query(`SELECT DISTINCT city FROM doctors ORDER BY city`);
  const { doctor_id } = req.query;

  let lockDoctor = false;
  let lockedDoctor = null;
  let chosenCity = '';
  let chosenDoctor = '';
  if (doctor_id) {
    const [[doc]] = await pool.query(
      `SELECT doctor_id, doctor_name, city, hospital_name, specialist FROM doctors WHERE doctor_id=?`,
      [doctor_id]
    );
    if (doc) {
      lockDoctor = true;
      lockedDoctor = doc;
      chosenCity = doc.city;
      chosenDoctor = String(doc.doctor_id);
    }
  }

  res.render('booking/index', {
    cities,
    lockDoctor,
    lockedDoctor,
    chosenCity,
    chosenDoctor,
    chosenDate: '',
    slots: [],
    errors: [],
    active:'booking'
  });
});


router.get('/doctor/:doctorId', (req, res) => {
  return res.redirect(`/booking?doctor_id=${encodeURIComponent(req.params.doctorId)}`);
});




/** JSON: doctors by city */
// router.get('/api/doctors', async (req, res) => {
//   const { city } = req.query;
//   if (!city) return res.json([]);
//   const [docs] = await pool.query(
//     `SELECT doctor_id, doctor_name, specialist, hospital_name FROM doctors WHERE city=? ORDER BY doctor_name`,
//     [city]
//   );
//   res.json(docs);
// });



router.get('/api/doctors', async (req, res) => {
  const { city, hospital } = req.query;

  if (!city && !hospital) return res.json([]);

  const [docs] = await pool.query(
    `
    SELECT doctor_id, doctor_name, specialist, hospital_name, city , doctor_fees , offer_text
    FROM doctors
    WHERE ${city ? 'city=?' : 'hospital_name=?'}
    ORDER BY doctor_name
    `,
    [city || hospital]
  );
  res.json(docs);
});


router.get('/api/hospitals', async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT DISTINCT hospital_name AS hospital
       FROM doctors
      WHERE hospital_name IS NOT NULL AND hospital_name <> ''
      ORDER BY hospital`
  );
  res.json(rows);
});



  router.get(['/by-hospital', '/by-hospital/:hospitalSlug'], async (req, res) => {
  console.log('patient', req.session.patient);

  // list hospitals (also compute slug so you can link to SEO URLs in the UI)
  const [hospitals] = await pool.query(
    `SELECT DISTINCT
        hospital_name AS hospital,
        REPLACE(LOWER(hospital_name), ' ', '-') AS slug
       FROM doctors
      WHERE hospital_name IS NOT NULL AND hospital_name <> ''
      ORDER BY hospital`
  );

  const slug = req.params.hospitalSlug || '';        // e.g. "sahara-hospital"
  const { doctor_id } = req.query;

  let lockDoctor = false;
  let lockedDoctor = null;
  let chosenHospital = '';
  let chosenDoctor = '';

  // If an SEO slug is provided, resolve to the real hospital name (case-insensitive)
  if (slug) {
    const [[hit]] = await pool.query(
      `SELECT DISTINCT hospital_name AS hospital
         FROM doctors
        WHERE hospital_name IS NOT NULL AND hospital_name <> ''
          AND REPLACE(LOWER(hospital_name), ' ', '-') = ?
        LIMIT 1`,
      [slug.toLowerCase()]
    );
    if (hit) {
      chosenHospital = hit.hospital;  // preselect this hospital in the UI
    } else {
      // Unknown slug: you can redirect to the generic page or show 404
      return res.redirect('/booking/by-hospital');
      // or: return res.status(404).send('Hospital not found');
    }
  }

  // If doctor_id is passed, lock that doctor (still supported)
  if (doctor_id) {
    const [[doc]] = await pool.query(
      `SELECT doctor_id, doctor_name, city, hospital_name, specialist, doctor_fees , offer_text
         FROM doctors
        WHERE doctor_id=?`,
      [doctor_id]
    );
    if (doc) {
      lockDoctor = true;
      lockedDoctor = doc;
      chosenHospital = chosenHospital || (doc.hospital_name || '');
      chosenDoctor = String(doc.doctor_id);
    }
  }

console.log('lockDoctor',lockDoctor)

  res.render('booking/by_hospital', {
    hospitals,        // now includes .slug
    lockDoctor,
    lockedDoctor,
    chosenHospital,   // used to preselect the hospital
    chosenDoctor,
    chosenDate: '',
    slots: [],
    errors: [],
    active: 'booking'
  });
});



/** JSON: slots by doctor+date (5-min, pruned) */
router.get('/api/slots', async (req, res) => {
  const { doctor_id, date } = req.query;
  if (!doctor_id || !date) return res.json([]);
  try {
    const slots = await getAvailableSlots(Number(doctor_id), date);
    res.json(slots);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load slots' });
  }
});


/** POST booking */
router.post('/',
  body('city').trim().notEmpty(),
  body('doctor_id').isInt({ min:1 }),
  body('appointment_date').isISO8601(),
  body('appointment_time').matches(/^\d{2}:\d{2}$/),
  body('patient_name').trim().notEmpty(),
  body('patient_phone').trim().isLength({ min: 7 }),
  async (req, res) => {
    const errors = validationResult(req);
    const { city, doctor_id, appointment_date, appointment_time, patient_name, patient_phone, prefill_locked } = req.body;

    const [cities] = await pool.query(`SELECT DISTINCT city FROM doctors ORDER BY city`);
    const lockDoctor = prefill_locked === '1';
    let lockedDoctor = null;
    if (lockDoctor) {
      const [[doc]] = await pool.query(
        `SELECT doctor_id, doctor_name, city, hospital_name, specialist FROM doctors WHERE doctor_id=?`,
        [doctor_id]
      );
      lockedDoctor = doc || null;
    }

    if (!errors.isEmpty()) {
      return res.status(422).render('booking/index', {
        cities, lockDoctor, lockedDoctor,
        chosenCity: city, chosenDoctor: doctor_id,
        chosenDate: appointment_date, slots: [],active:'booking',
        errors: errors.array()
      });
    }

    // Guard: past time
    const now = new Date();
    const pick = new Date(`${appointment_date}T${appointment_time}:00`);
    if (pick < now) {
      return res.status(422).render('booking/index', {
        cities, lockDoctor, lockedDoctor,
        chosenCity: city, chosenDoctor: doctor_id,active:'booking',
        chosenDate: appointment_date, slots: [],
        errors: [{ msg: 'Selected time is in the past. Please choose a future slot.' }]
      });
    }

    try {
      // NEW: same user cannot book multiple slots for same doctor & date
      const [[dupe]] = await pool.query(
        `SELECT appointment_time, appointment_no
           FROM bookings
          WHERE doctor_id=? AND appointment_date=? AND patient_phone=?
          LIMIT 1`,
        [doctor_id, appointment_date, patient_phone]
      );
      if (dupe) {
        return res.status(409).render('booking/index', {
          cities, lockDoctor, lockedDoctor,
          chosenCity: city, chosenDoctor: doctor_id,active:'booking',
          chosenDate: appointment_date, slots: [],
          errors: [{ msg: `Your appointment is already booked for ${dupe.appointment_time.slice(0,5)} (No. ${dupe.appointment_no}). You can’t book another slot with the same doctor on this day.` }]
        });
      }

      // Validate slot is still available
      const avail = await getAvailableSlots(Number(doctor_id), appointment_date);
      if (!avail.includes(appointment_time)) {
        return res.status(409).render('booking/index', {
          cities, lockDoctor, lockedDoctor,
          chosenCity: city, chosenDoctor: doctor_id,active:'booking',
          chosenDate: appointment_date, slots: [],
          errors: [{ msg: 'That time just got booked or is not available anymore. Please pick another slot.' }]
        });
      }

      // Transaction: assign appointment_no and insert
      try {

        const [[{ max_no }]] = await pool.query(
          `SELECT COALESCE(MAX(appointment_no),0) AS max_no
             FROM bookings WHERE doctor_id=? AND appointment_date=? FOR UPDATE`,
          [doctor_id, appointment_date]
        );
        const apptNo = Number(max_no) + 1;

        await pool.query(
          `INSERT INTO bookings
            (doctor_id, appointment_date, appointment_time, patient_name, patient_phone, appointment_no)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [doctor_id, appointment_date, appointment_time, patient_name, patient_phone, apptNo]
        );

             req.session.patient = {
  phone: patient_phone,
  name: patient_name,
  lastDoctorId: Number(doctor_id)
};

        const [[doc]] = await pool.query(
          `SELECT doctor_name, hospital_name, city FROM doctors WHERE doctor_id=?`,
          [doctor_id]
        );
   
        return res.render('booking/confirm', {
          conf: {
            appointment_no: apptNo,
            appointment_date,
            appointment_time,
            doctor_name: doc?.doctor_name || `Doctor #${doctor_id}`,
            hospital_name: doc?.hospital_name || '-',
            city: doc?.city || city,
            patient_name, patient_phone,
           
          },active:'booking',
        });

      } catch (err) {
        
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).render('booking/index', {
            cities, lockDoctor, lockedDoctor,
            chosenCity: city, chosenDoctor: doctor_id,
            chosenDate: appointment_date, slots: [],
            errors: [{ msg: 'That time was just booked. Please choose another slot.' }],
            active:'booking'
          });
        }
        console.error(err);
        return res.status(500).render('booking/index', {
          cities, lockDoctor, lockedDoctor,
          chosenCity: city, chosenDoctor: doctor_id,
          active:'booking',
          chosenDate: appointment_date, slots: [],
          errors: [{ msg: (process.env.NODE_ENV === 'production') ? 'Could not create booking.' : `DB error: ${err.code} ${err.sqlMessage}` }]
        });
      }
    } catch (e) {
      console.error(e);
      return res.status(500).render('booking/index', {
        cities, lockDoctor, lockedDoctor,active:'booking',
        chosenCity: city, chosenDoctor: doctor_id,
        chosenDate: appointment_date, slots: [],
        errors: [{ msg: 'Failed to compute availability. Try again.' }]
      });
    }
  }
);



// router.post('/hospital',
//  body('hospital').trim().notEmpty().withMessage('Hospital is required'),
//   body('doctor_id').isInt({ min:1 }),
//   body('appointment_date').isISO8601(),
//   body('appointment_time').matches(/^\d{2}:\d{2}$/),
//   body('patient_name').trim().notEmpty(),
//   body('patient_phone').trim().isLength({ min: 7 }),
  
//   async (req, res) => {
//     const errors = validationResult(req);
//     const { city= 'Paras Children Clinic', doctor_id, appointment_date, appointment_time, patient_name, patient_phone, prefill_locked } = req.body;

// console.log('body',req.body)

//     const [hospitals] = await pool.query(`SELECT DISTINCT hospital_name FROM doctors ORDER BY hospital_name`);
//     const lockDoctor = prefill_locked === '1';
//     let lockedDoctor = null;
//     if (lockDoctor) {
//       const [[doc]] = await pool.query(
//         `SELECT doctor_id, doctor_name, city, hospital_name, specialist FROM doctors WHERE doctor_id=?`,
//         [doctor_id]
//       );
//       lockedDoctor = doc || null;
//     }

//     if (!errors.isEmpty()) {
//       return res.status(422).render('booking/by_hospital', {
//         hospitals, lockDoctor, lockedDoctor,
//         chosenHospital: city, chosenDoctor: doctor_id,
//         chosenDate: appointment_date, slots: [],active:'booking',
//         errors: errors.array()
//       });
//     }

//     // Guard: past time
//     const now = new Date();
//     const pick = new Date(`${appointment_date}T${appointment_time}:00`);
//     if (pick < now) {
//       return res.status(422).render('booking/by_hospital', {
//         hospitals, lockDoctor, lockedDoctor,
//         chosenHospital: city, chosenDoctor: doctor_id,active:'booking',
//         chosenDate: appointment_date, slots: [],
//         errors: [{ msg: 'Selected time is in the past. Please choose a future slot.' }]
//       });
//     }

//     try {
//       // NEW: same user cannot book multiple slots for same doctor & date
//       const [[dupe]] = await pool.query(
//         `SELECT appointment_time, appointment_no
//            FROM bookings
//           WHERE doctor_id=? AND appointment_date=? AND patient_phone=?
//           LIMIT 1`,
//         [doctor_id, appointment_date, patient_phone]
//       );
//       if (dupe) {
//         return res.status(409).render('booking/by_hospital', {
//           hospitals, lockDoctor, lockedDoctor,
//           chosenHospital: city, chosenDoctor: doctor_id,active:'booking',
//           chosenDate: appointment_date, slots: [],
//           errors: [{ msg: `Your appointment is already booked for ${dupe.appointment_time.slice(0,5)} (No. ${dupe.appointment_no}). You can’t book another slot with the same doctor on this day.` }]
//         });
//       }

//       // Validate slot is still available
//       const avail = await getAvailableSlots(Number(doctor_id), appointment_date);
//       if (!avail.includes(appointment_time)) {
//         return res.status(409).render('booking/by_hospital', {
//           hospitals, lockDoctor, lockedDoctor,
//           chosenHospital: city, chosenDoctor: doctor_id,active:'booking',
//           chosenDate: appointment_date, slots: [],
//           errors: [{ msg: 'That time just got booked or is not available anymore. Please pick another slot.' }]
//         });
//       }

//       // Transaction: assign appointment_no and insert
//       try {

//         const [[{ max_no }]] = await pool.query(
//           `SELECT COALESCE(MAX(appointment_no),0) AS max_no
//              FROM bookings WHERE doctor_id=? AND appointment_date=? FOR UPDATE`,
//           [doctor_id, appointment_date]
//         );
//         const apptNo = Number(max_no) + 1;

//         await pool.query(
//           `INSERT INTO bookings
//             (doctor_id, appointment_date, appointment_time, patient_name, patient_phone, appointment_no)
//            VALUES (?, ?, ?, ?, ?, ?)`,
//           [doctor_id, appointment_date, appointment_time, patient_name, patient_phone, apptNo]
//         );

//              req.session.patient = {
//   phone: patient_phone,
//   name: patient_name,
//   lastDoctorId: Number(doctor_id)
// };

//         const [[doc]] = await pool.query(
//           `SELECT doctor_name, hospital_name, city FROM doctors WHERE doctor_id=?`,
//           [doctor_id]
//         );
   
//         return res.render('booking/confirm', {
//           conf: {
//             appointment_no: apptNo,
//             appointment_date,
//             appointment_time,
//             doctor_name: doc?.doctor_name || `Doctor #${doctor_id}`,
//             hospital_name: doc?.hospital_name || '-',
//             city: doc?.city || city,
//             patient_name, patient_phone,
           
//           },active:'booking',
//         });

//       } catch (err) {
        
//         if (err.code === 'ER_DUP_ENTRY') {
//           return res.status(409).render('booking/by_hospital', {
//             hospitals, lockDoctor, lockedDoctor,
//             chosenHospital: city, chosenDoctor: doctor_id,
//             chosenDate: appointment_date, slots: [],
//             errors: [{ msg: 'That time was just booked. Please choose another slot.' }],
//             active:'booking'
//           });
//         }
//         console.error(err);
//         return res.status(500).render('booking/by_hospital', {
//           hospitals, lockDoctor, lockedDoctor,
//           chosenHospital: city, chosenDoctor: doctor_id,
//           active:'booking',
//           chosenDate: appointment_date, slots: [],
//           errors: [{ msg: (process.env.NODE_ENV === 'production') ? 'Could not create booking.' : `DB error: ${err.code} ${err.sqlMessage}` }]
//         });
//       }
//     } catch (e) {
//       console.error(e);
//       return res.status(500).render('booking/by_hospital', {
//         hospitals, lockDoctor, lockedDoctor,active:'booking',
//         chosenHospital: city, chosenDoctor: doctor_id,
//         chosenDate: appointment_date, slots: [],
//         errors: [{ msg: 'Failed to compute availability. Try again.' }]
//       });
//     }
//   }
// );


router.post('/hospital',
  body('hospital').trim().notEmpty().withMessage('Hospital is required'),
  body('doctor_id').isInt({ min: 1 }),
  body('appointment_date').isISO8601(),
  body('appointment_time').matches(/^\d{2}:\d{2}$/),
  body('patient_name').trim().notEmpty(),
  body('patient_phone').trim().isLength({ min: 7 }),
  async (req, res) => {
    const errors = validationResult(req);
    const {
      hospital, doctor_id, appointment_date, appointment_time,
      patient_name, patient_phone, prefill_locked
    } = req.body;

    console.log('body',req.body)

    // data needed to re-render on error
    const [hospitals] = await pool.query(
      `SELECT DISTINCT hospital_name AS hospital
         FROM doctors
        WHERE hospital_name IS NOT NULL AND hospital_name <> ''
        ORDER BY hospital`
    );

    const lockDoctor = prefill_locked === '1';
    let lockedDoctor = null;
    if (lockDoctor) {
      const [[doc]] = await pool.query(
        `SELECT doctor_id, doctor_name, city, hospital_name, specialist FROM doctors WHERE doctor_id=?`,
        [doctor_id]
      );
      lockedDoctor = doc || null;
    }

    if (!errors.isEmpty()) {
      return res.status(422).render('booking/by_hospital', {
        hospitals,
        lockDoctor,
        lockedDoctor,
        chosenHospital: hospital || '',
        chosenDoctor: String(doctor_id || ''),
        chosenDate: appointment_date || '',
        slots: [],
        errors: errors.array(),
        active: 'booking'
      });
    }

    try {
      // (Optional) sanity: ensure doctor belongs to that hospital
      const [[chk]] = await pool.query(
        `SELECT 1 FROM doctors WHERE doctor_id=? AND hospital_name=? LIMIT 1`,
        [doctor_id, hospital]
      );
      if (!chk) {
        return res.status(400).render('booking/by_hospital', {
          hospitals, lockDoctor, lockedDoctor,
          chosenHospital: hospital, chosenDoctor: String(doctor_id), chosenDate: appointment_date,
          slots: [],
          errors: [{ msg: 'Selected doctor is not attached to the chosen hospital.' }],
          active: 'booking'
        });
      }

      // Past time guard
      const now = new Date();
      const pick = new Date(`${appointment_date}T${appointment_time}:00`);
      if (pick < now) {
        return res.status(422).render('booking/by_hospital', {
          hospitals, lockDoctor, lockedDoctor,
          chosenHospital: hospital, chosenDoctor: String(doctor_id), chosenDate: appointment_date,
          slots: [],
          errors: [{ msg: 'Selected time is in the past. Please choose a future slot.' }],
          active: 'booking'
        });
      }

      // Same user cannot double-book same doctor/day
      const [[dupe]] = await pool.query(
        `SELECT appointment_time, appointment_no
           FROM bookings
          WHERE doctor_id=? AND appointment_date=? AND patient_phone=?
          LIMIT 1`,
        [doctor_id, appointment_date, patient_phone]
      );
      if (dupe) {
        return res.status(409).render('booking/by_hospital', {
          hospitals, lockDoctor, lockedDoctor,
          chosenHospital: hospital, chosenDoctor: String(doctor_id), chosenDate: appointment_date,
          slots: [],
          errors: [{ msg: `Your appointment is already booked for ${dupe.appointment_time.slice(0,5)} (No. ${dupe.appointment_no}).You can’t book another slot with the same doctor on this day.` }],
          active: 'booking'
        });
      }

      // Slot still available?
      const avail = await getAvailableSlots(Number(doctor_id), appointment_date);
      if (!avail.includes(appointment_time)) {
        return res.status(409).render('booking/by_hospital', {
          hospitals, lockDoctor, lockedDoctor,
          chosenHospital: hospital, chosenDoctor: String(doctor_id), chosenDate: appointment_date,
          slots: [],
          errors: [{ msg: 'That time just got booked or is not available.' }],
          active: 'booking'
        });
      }

      // Transaction: assign appointment_no and insert
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        const [[{ max_no }]] = await conn.query(
          `SELECT COALESCE(MAX(appointment_no),0) AS max_no
             FROM bookings WHERE doctor_id=? AND appointment_date=? FOR UPDATE`,
          [doctor_id, appointment_date]
        );
        const apptNo = Number(max_no) + 1;

        await conn.query(
          `INSERT INTO bookings
            (doctor_id, appointment_date, appointment_time, patient_name, patient_phone, appointment_no)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [doctor_id, appointment_date, appointment_time, patient_name, patient_phone, apptNo]
        );

        await conn.commit();
        conn.release();

        // Store patient session (keep hospital too)
        req.session.patient = {
          ...(req.session.patient || {}),
          phone: patient_phone,
          name: patient_name,
          lastDoctorId: Number(doctor_id),
          lastHospital: hospital
        };

        const [[doc]] = await pool.query(
          `SELECT doctor_name, hospital_name, city FROM doctors WHERE doctor_id=?`,
          [doctor_id]
        );

        return res.render('booking/confirm', {
          conf: {
            appointment_no: apptNo,
            appointment_date,
            appointment_time,
            doctor_name: doc?.doctor_name || `Doctor #${doctor_id}`,
            hospital_name: doc?.hospital_name || hospital,
            city: doc?.city || '-',
            patient_name, patient_phone,
            
          },
          active:'booking'
        });

      } catch (err) {
        await conn.rollback();
        conn.release();
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).render('booking/by_hospital', {
            hospitals, lockDoctor, lockedDoctor,
            chosenHospital: hospital, chosenDoctor: String(doctor_id), chosenDate: appointment_date,
            slots: [],
            errors: [{ msg: 'That time was just booked. Please choose another slot.' }],
            active: 'booking'
          });
        }
        console.error(err);
        return res.status(500).render('booking/by_hospital', {
          hospitals, lockDoctor, lockedDoctor,
          chosenHospital: hospital, chosenDoctor: String(doctor_id), chosenDate: appointment_date,
          slots: [],
          errors: [{ msg: (process.env.NODE_ENV === 'production') ? 'Could not create booking.' : `DB error: ${err.code} ${err.sqlMessage}` }],
          active: 'booking'
        });
      }

    } catch (e) {
      console.error(e);
      return res.status(500).render('booking/by_hospital', {
        hospitals, lockDoctor, lockedDoctor,
        chosenHospital: hospital || '',
        chosenDoctor: String(doctor_id || ''),
        chosenDate: appointment_date || '',
        slots: [],
        errors: [{ msg: 'Failed to compute availability. Try again.' }],
        active: 'booking'
      });
    }
  }
);

module.exports = router;
