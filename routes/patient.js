// routes/patient.js
var express = require('express');
var router = express.Router();

var { body, validationResult } = require('express-validator');

var pool = require('./db')

function ensurePatient(req, res, next) {
  if (req.session?.patient?.phone) return next();
  // No session yet — send them to booking to create one
  return res.redirect('/booking');
}

router.get('/my/bookings', ensurePatient, async (req, res) => {
  const phone = req.session.patient.phone;
  console.log('phone',phone)

  // today
  const today = new Date().toISOString().slice(0,10);

  const [upcoming] = await pool.query(
    `SELECT b.booking_id, b.appointment_date, b.appointment_time, b.appointment_no, b.status,
            d.doctor_name, d.city, d.hospital_name
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
    upcoming,
    past,
    active:'mybooking'
  });
});

router.post('/my/logout', (req, res) => {
  if (req.session?.patient) delete req.session.patient;
  res.redirect('/booking');
});

module.exports = router;
