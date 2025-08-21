// routes/queue.js
var express = require('express');
var router = express.Router();

var { body, validationResult } = require('express-validator');

var pool = require('./db')


function ensurePatient(req, res, next) {
  if (req.session?.patient) return next();
  return res.redirect('/my/login');
}


router.get('/', async (req, res) => {
  const doctor_id = Number(req.query.doctor_id || req.session.patient?.lastDoctorId || 0);
  const phone     = (req.query.phone || req.session.patient?.phone || '').trim();

  // If no doctor and no patient session → login
  if (!doctor_id || !phone) {
    return res.redirect('/my/login');
  }

  const today = new Date().toISOString().slice(0,10);
  const data  = await computeQueue(doctor_id, today, phone);

  res.render('queue/index', {
    data,
    doctor_id,
    phone,
    active: 'queue'
  });
});


router.get('/api', async (req, res) => {
  const doctor_id = Number(req.query.doctor_id || 0);
  if (!doctor_id) return res.status(400).json({ error: 'doctor_id required' });
  const today = new Date().toISOString().slice(0,10);
  const phone = (req.query.phone || '').trim();
   console.log('doctor_id',doctor_id)
   console.log('appointment_date',today)
   console.log('patient_phone',phone)
  const data = await computeQueue(doctor_id, today, phone);

  res.json(data);
});

async function computeQueue(doctor_id, dateISO, phone) {
  const [[doc]] = await pool.query(
    `SELECT doctor_name, hospital_name, city FROM doctors WHERE doctor_id=?`,
    [doctor_id]
  );
  const [[{ cur }]] = await pool.query(
    `SELECT COALESCE(MAX(appointment_no),0) AS cur
       FROM bookings WHERE doctor_id=? AND appointment_date=? AND status='completed'`,
    [doctor_id, dateISO]
  );
  const next_no = cur + 1;

  // Total remaining today
  const [[{ totalBooked }]] = await pool.query(
    `SELECT COUNT(*) AS totalBooked FROM bookings
      WHERE doctor_id=? AND appointment_date=? AND status='booked'`,
    [doctor_id, dateISO]
  );

  let your_no = null, people_ahead = null, eta_minutes = null, eta_time = null;
  
  if (phone) {
    const [[mine]] = await pool.query(
      `SELECT appointment_no FROM bookings
        WHERE doctor_id=? AND appointment_date=? AND patient_phone=? LIMIT 1`,
      [doctor_id, dateISO, phone]
    );
  
   
    console.log('mine',mine)
   
    if (mine) {
      your_no = mine.appointment_no;
      people_ahead = Math.max(0, your_no - next_no);
      eta_minutes = people_ahead * 5; // each patient 5 min
      const etaDate = new Date(Date.now() + eta_minutes * 60000);
      eta_time = etaDate.toTimeString().slice(0,5);
    }
  }

  return {
    doctor: { doctor_name: doc?.doctor_name, hospital_name: doc?.hospital_name, city: doc?.city },
    date: dateISO,
    current_running_no: cur,
    next_no,
    total_waiting: totalBooked,
    your_no,
    people_ahead,
    eta_minutes,
    eta_time
  };
}

module.exports = router;
