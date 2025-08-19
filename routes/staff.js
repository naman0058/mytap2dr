// routes/staff.js

var express = require('express');
var router = express.Router();

var { body, validationResult } = require('express-validator');

var pool = require('./db')


var bcrypt = require('bcrypt');


function ensureStaff(req, res, next) {
  if (req.session?.staff) return next();
  return res.redirect('/staff/login');
}

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
    const [[st]] = await pool.query(
      `SELECT staff_id, doctor_id, full_name, email, password_hash, is_active
         FROM staff WHERE email=?`,
      [email]
    );
    if (!st || !st.is_active) {
      return res.status(401).render('staff/login', { errors: [{ msg:'Invalid credentials' }], email });
    }
    const ok = await bcrypt.compare(password, st.password_hash);
    if (!ok) {
      return res.status(401).render('staff/login', { errors: [{ msg:'Invalid credentials' }], email });
    }
    req.session.staff = {
      staff_id: st.staff_id,
      doctor_id: st.doctor_id,
      full_name: st.full_name,
      email: st.email
    };
    res.redirect('/staff/dashboard');
  }
);

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/staff/login'));
});

/* Dashboard: Today's list for this staff's doctor, tap to complete, CSV download */
router.get('/dashboard', ensureStaff, async (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const doctor_id = req.session.staff.doctor_id;

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
    current_running_no: cur
  });
});

/* Mark a booking as completed (tap button) */
router.post('/complete/:id', ensureStaff, async (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const doctor_id = req.session.staff.doctor_id;
  const booking_id = req.params.id;

  // Only allow completing today's bookings of this doctor and not already completed
  const [r] = await pool.query(
    `UPDATE bookings
        SET status='completed', completed_at=NOW()
      WHERE booking_id=? AND doctor_id=? AND appointment_date=? AND status='booked'`,
    [booking_id, doctor_id, today]
  );
  // r.affectedRows === 0 means nothing changed (wrong doctor/day or already completed)
  res.redirect('/staff/dashboard');
});

/* CSV download of today's list */
router.get('/today.csv', ensureStaff, async (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const doctor_id = req.session.staff.doctor_id;

  const [rows] = await pool.query(
    `SELECT appointment_no, appointment_time, patient_name, patient_phone, status
       FROM bookings
      WHERE doctor_id=? AND appointment_date=?
      ORDER BY appointment_no`,
    [doctor_id, today]
  );

  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="appointments_${today}.csv"`);
  res.write('No,Time,Patient,Phone,Status\n');
  rows.forEach(r => {
    res.write(`${r.appointment_no},${r.appointment_time.slice(0,5)},${JSON.stringify(r.patient_name)},${JSON.stringify(r.patient_phone)},${r.status}\n`);
  });
  res.end();
});

module.exports = router;
