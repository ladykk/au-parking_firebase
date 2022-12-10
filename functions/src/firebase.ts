import * as admin from "firebase-admin";

admin.initializeApp();

export const Auth = admin.auth;
export const Firestore = admin.firestore;
export const Storage = admin.storage().bucket;
export const RTDatabase = admin.database;
