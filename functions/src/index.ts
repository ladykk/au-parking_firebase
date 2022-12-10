import { Firestore } from "./firebase";

// Settings Firestore
Firestore().settings({ ignoreUndefinedProperties: true });

exports.customers = require("./controller/customer");
exports.staffs = require("./controller/staff");
exports.cars = require("./controller/car");
exports.transactions = require("./controller/transaction");
exports.bot = require("./controller/bot");
