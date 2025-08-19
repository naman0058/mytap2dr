var createError = require('http-errors');
var cookieSession = require('cookie-session')
const http = require('http');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var methodOverride = require('method-override')



var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var doctorsRouter = require('./routes/doctors');
var openHoursRouter = require('./routes/openHours');
var exceptionsRouter = require('./routes/exceptions');
var bookingRouter = require('./routes/booking');
var adminRouter = require('./routes/admin');
var staffRouter  = require('./routes/staff.js');
var staffAdminRouter  = require('./routes/staffAdmin.js');
var queueRouter  = require('./routes/queue.js');
var patientRouter = require('./routes/patient.js');


var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));


app.use(cookieSession({
  name: 'session',
  keys: ['naman'],

  // Cookie Options
  maxAge: 24 * 60 * 60 * 1000 // 24 hours
}))


app.use('/', patientRouter); 
app.use('/users', usersRouter);
app.use('/doctors', doctorsRouter);
app.use('/open-hours', openHoursRouter);
app.use('/exceptions', exceptionsRouter);
app.use('/booking', bookingRouter);
app.use('/admin', adminRouter);
// routes
app.use('/staff', staffRouter);         // login/dashboard/actions
app.use('/admin/staff', staffAdminRouter); // doctor/admin adds staff
app.use('/queue', queueRouter);         // public live queue page + API

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});


app.use((req, res, next) => {
  res.locals.patient = req.session.patient || null;
  next();
});

app.use(methodOverride(function (req, res) {
  if (req.body && typeof req.body === 'object' && '_method' in req.body) {
    const method = req.body._method;
    delete req.body._method;
    return method;
  }
  if (req.query && typeof req.query._method === 'string') {
    const method = req.query._method;
    delete req.query._method;
    return method;
  }
}));

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
