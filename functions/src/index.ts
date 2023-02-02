import * as admin from "firebase-admin";

// > Initialize firebase.
admin.initializeApp();
export const Auth = admin.auth;
export const Firestore = admin.firestore;
export const Storage = admin.storage().bucket;
export const RTDatabase = admin.database;
Firestore().settings({ ignoreUndefinedProperties: true });

exports.customers = require("./controller/customer");
exports.staffs = require("./controller/staff");
exports.cars = require("./controller/car");
exports.transactions = require("./controller/transaction");
exports.bot = require("./controller/bot");
