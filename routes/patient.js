// routes/patient.js
var express = require('express');
var router = express.Router();

var { body, validationResult } = require('express-validator');

var pool = require('./db')


function toYMDLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ensurePatient(req, res, next) {
  if (req.session?.patient) return next();
  return res.redirect('/my/login');
}


router.get('/my/login', (req, res) => {
  if (req.session?.patient) return res.redirect('/my/bookings');
  res.render('patient/login', { errors: [], phone: '' });
});


// POST: verify phone & create session if exists
router.post(
  '/my/login',
  body('phone').trim().matches(/^\d{10}$/).withMessage('Enter valid 10-digit mobile number'),
  async (req, res) => {
    const errors = validationResult(req);
    const phone = (req.body.phone || '').trim();
    console.log('hpn',req.body.phone)
    if (!errors.isEmpty()) {
      return res.status(422).render('patient/login', { errors: errors.array(), phone });
    }

    // Find the most recent booking for this phone
    const [rows] = await pool.query(
      `SELECT b.patient_name, b.patient_phone, b.doctor_id
         FROM bookings b
        WHERE b.patient_phone = ?
        ORDER BY b.appointment_date DESC, b.appointment_time DESC
        LIMIT 1`,
      [phone]
    );

    if (!rows.length) {
      // no bookings with this phone
      return res.status(404).render('patient/login', {
        errors: [{ msg: 'No appointment found for this mobile number / इस मोबाइल नंबर के लिए कोई अपॉइंटमेंट नहीं मिला' }],
        phone
      });
    }

    const { patient_name, patient_phone, doctor_id } = rows[0];
    req.session.patient = {
      phone: patient_phone,
      name: patient_name,
      lastDoctorId: Number(doctor_id)
    };

    return res.redirect('/my/bookings');
  }
);


router.post('/my/logout', (req, res) => {
  req.session.patient = null;
  res.redirect('/my/login');
});

router.get('/demo', function(req, res, next) {
  res.redirect('/booking?doctor_id=17')
});

router.get('/my/bookings', ensurePatient, async (req, res) => {
  const phone = req.session.patient.phone;

  // Local YYYY-MM-DD to avoid UTC drift
  const today = toYMDLocal();

  const [upcoming] = await pool.query(
    `SELECT b.booking_id, b.appointment_date, b.appointment_time, b.appointment_no, b.status,
            d.doctor_name, d.city, d.hospital_name, b.doctor_id
       FROM bookings b
       JOIN doctors d ON d.doctor_id=b.doctor_id
      WHERE b.patient_phone=? AND b.appointment_date >= ?
      ORDER BY b.appointment_date, b.appointment_time`,
    [phone, today]
  );

  const [past] = await pool.query(
    `SELECT b.booking_id, b.appointment_date, b.appointment_time, b.appointment_no, b.status,
            d.doctor_name, d.city, d.hospital_name
       FROM bookings b
       JOIN doctors d ON d.doctor_id=b.doctor_id
      WHERE b.patient_phone=? AND b.appointment_date < ?
      ORDER BY b.appointment_date DESC, b.appointment_time DESC
      LIMIT 200`,
    [phone, today]
  );

  res.render('patient/bookings', {
    patient: req.session.patient,
    upcoming, past,
    active:'mybooking'
  });
});



module.exports = router;
