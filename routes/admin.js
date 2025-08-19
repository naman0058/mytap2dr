var express = require('express');
var router = express.Router();

var { body, validationResult } = require('express-validator');

var pool = require('./db')



router.get('/bookings', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  const [rows] = await pool.query(
    `SELECT b.booking_id, b.appointment_date, b.appointment_time, b.patient_name, b.patient_phone,
            b.appointment_no, d.doctor_name, d.city, d.hospital_name
       FROM bookings b
       JOIN doctors d ON d.doctor_id=b.doctor_id
      WHERE b.appointment_date = ?
      ORDER BY d.city, d.doctor_name, b.appointment_time`,
    [date]
  );
  res.render('admin/bookings/index', { rows, date });
});

module.exports = router;
