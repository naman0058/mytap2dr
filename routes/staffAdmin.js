// routes/staffAdmin.js

var express = require('express');
var router = express.Router();

var { body, validationResult } = require('express-validator');

var pool = require('./db')


var bcrypt = require('bcrypt');


module.exports = router;