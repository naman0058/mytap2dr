// routes/staff.js
var express = require('express');
var router = express.Router();
var { body, validationResult } = require('express-validator');
var pool = require('./db');
var bcrypt = require('bcrypt');

/* Helpers */
async function fetchStaffByEmail(email) {
  const [[st]] = await pool.query(
    `SELECT staff_id, doctor_id, full_name, email, password_hash, is_active
       FROM staff WHERE email=?`,
    [email]
  );
  return st || null;
}
async function fetchDoctorsForStaff(staff_id) {
  const [rows] = await pool.query(
    `SELECT sd.doctor_id, d.doctor_name, d.hospital_name, d.city
       FROM staff_doctors sd
       JOIN doctors d ON d.doctor_id = sd.doctor_id
      WHERE sd.staff_id=?
      ORDER BY d.doctor_name`,
    [staff_id]
  );
  return rows; // [{doctor_id,doctor_name,hospital_name,city}, ...]
}
function ensureStaff(req, res, next) {
  if (req.session?.staff) return next();
  return res.redirect('/staff/login');
}
// pick an active doctor (from query or from session)
function resolveActiveDoctor(req) {
  const allowed = req.session.staff.doctor_ids || [];
  let active = req.session.staff.active_doctor_id || null;

  // allow /staff/dashboard?doctor_id=XX to switch
  const qid = req.query.doctor_id ? Number(req.query.doctor_id) : null;
  if (qid && allowed.includes(qid)) {
    active = qid;
    req.session.staff.active_doctor_id = qid;
  }
  if (!active && allowed.length) {
    active = allowed[0];
    req.session.staff.active_doctor_id = active;
  }
  return active;
}

/* Auth */
router.get('/login', (req, res) => {
  if (req.session?.staff) return res.redirect('/staff/dashboard');
  res.render('staff/login', { errors: [], email: '' });
});

router.post('/login',
  body('email').isEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required'),
  async (req, res) => {
    const errors = validationResult(req);
    const { email, password } = req.body;
    if (!errors.isEmpty()) {
      return res.status(422).render('staff/login', { errors: errors.array(), email });
    }

    const st = await fetchStaffByEmail(email);
    if (!st || !st.is_active) {
      return res.status(401).render('staff/login', { errors: [{ msg:'Invalid credentials' }], email });
    }
    const ok = await bcrypt.compare(password, st.password_hash);
    if (!ok) {
      return res.status(401).render('staff/login', { errors: [{ msg:'Invalid credentials' }], email });
    }

    // load all permitted doctors for this staff
    const doctors = await fetchDoctorsForStaff(st.staff_id);
    const doctor_ids = doctors.map(d => d.doctor_id);
    // fallback to legacy staff.doctor_id if link table empty
    if (!doctor_ids.length && st.doctor_id) doctor_ids.push(st.doctor_id);
    const active_doctor_id = doctor_ids[0] || null;

    req.session.staff = {
      staff_id: st.staff_id,
      full_name: st.full_name,
      email: st.email,
      doctor_ids,
      active_doctor_id,
      doctors // [{doctor_id,doctor_name,hospital_name,city}]
    };
    res.redirect('/staff/dashboard');
  }
);

router.post('/logout', (req, res) => {
  // works with cookie-session or express-session
  const cookieName = 'sid';
  if (!req.session) {
    res.clearCookie(cookieName);
    return res.redirect('/staff/login');
  }
  if (typeof req.session.destroy === 'function') {
    return req.session.destroy(() => {
      res.clearCookie(cookieName);
      res.redirect('/staff/login');
    });
  }
  req.session = null;
  res.clearCookie(cookieName);
  res.redirect('/staff/login');
});

/* Dashboard: show today's list for the ACTIVE doctor, allow switching */
router.get('/dashboard', ensureStaff, async (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const doctor_id = resolveActiveDoctor(req);
  if (!doctor_id) {
    return res.status(403).render('staff/empty', {
      staff: req.session.staff,
      msg: 'No doctors assigned to your staff account.'
    });
  }

  const [rows] = await pool.query(
    `SELECT b.booking_id, b.appointment_no, b.appointment_time, b.patient_name, b.patient_phone, b.status
       FROM bookings b
      WHERE b.doctor_id=? AND b.appointment_date=?
      ORDER BY b.appointment_no`,
    [doctor_id, today]
  );

  // current running = max completed
  const [[{ cur }]] = await pool.query(
    `SELECT COALESCE(MAX(appointment_no),0) AS cur
       FROM bookings WHERE doctor_id=? AND appointment_date=? AND status='completed'`,
    [doctor_id, today]
  );

  res.render('staff/dashboard', {
    staff: req.session.staff,
    date: today,
    rows,
    current_running_no: cur,
    active_doctor_id: doctor_id
  });
});

/* Switch active doctor (button/dropdown posts here) */
router.post('/switch', ensureStaff, body('doctor_id').isInt({min:1}), (req, res) => {
  const id = Number(req.body.doctor_id);
  const allowed = req.session.staff.doctor_ids || [];
  if (!allowed.includes(id)) return res.status(403).send('Not allowed for this doctor.');
  req.session.staff.active_doctor_id = id;
  res.redirect('/staff/dashboard');
});

/* Mark a booking as completed (tap button) */
router.post('/complete/:id', ensureStaff, async (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const doctor_id = resolveActiveDoctor(req);
  const booking_id = req.params.id;

  // Only allow completing today's bookings of the ACTIVE doctor and not already completed
  await pool.query(
    `UPDATE bookings
        SET status='completed', completed_at=NOW()
      WHERE booking_id=? AND doctor_id=? AND appointment_date=? AND status='booked'`,
    [booking_id, doctor_id, today]
  );
  res.redirect('/staff/dashboard');
});

/* CSV download of today's list for the ACTIVE doctor */
router.get('/today.csv', ensureStaff, async (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const doctor_id = resolveActiveDoctor(req);

  const [rows] = await pool.query(
    `SELECT appointment_no, appointment_time, patient_name, patient_phone, status
       FROM bookings
      WHERE doctor_id=? AND appointment_date=?
      ORDER BY appointment_no`,
    [doctor_id, today]
  );

  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="appointments_${today}_doctor_${doctor_id}.csv"`);
  res.write('No,Time,Patient,Phone,Status\n');
  rows.forEach(r => {
    res.write(`${r.appointment_no},${r.appointment_time.slice(0,5)},${JSON.stringify(r.patient_name)},${JSON.stringify(r.patient_phone)},${r.status}\n`);
  });
  res.end();
});

module.exports = router;
