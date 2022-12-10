import * as functions from "firebase-functions";
import { Firestore } from "../firebase";
import {
  DocumentReference,
  DocumentData,
  FieldValue,
} from "@google-cloud/firestore";
import axios, { AxiosError } from "axios";

// [Secret]
const APP_SECRET = process.env.APP_SECRET as string;

// [Bot]
const BOT = axios.create({
  baseURL: "https://asia-southeast2-au-parking.cloudfunctions.net/bot",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    SECRET: APP_SECRET,
  },
});
BOT.interceptors.response.use(
  (response) => response,
  (err) => {
    if (err instanceof AxiosError)
      console.error(`response error: ${err.response?.data}.`);
    else console.error(`cannot send api.`);
  }
);

// [Car]
type Car = {
  [index: string]: string;
  license_number: string;
  province: string;
  brand: string;
  color: string;
};

type CarOwners = {
  [index: string]: string | Array<DocumentReference<DocumentData>>;
  license_number: string;
  owners: Array<DocumentReference<DocumentData>>;
};

// F - Event on "customers/cars" being write.
exports.onCustomersCarsWrite = functions
  .region("asia-southeast2")
  .runWith({ timeoutSeconds: 300 })
  .firestore.document("/customers/{customer_uid}/cars/{license_number}")
  .onWrite(async (changes, context) => {
    // Format parameters.
    const customer_uid = context.params.customer_uid;
    const license_number = context.params.license_number;
    const old_car: Car | null = changes.before.exists
      ? (changes.before.data() as Car)
      : null;
    const new_car: Car | null = changes.after.exists
      ? (changes.after.data() as Car)
      : null;
    const car_owners_ref = Firestore().collection("cars").doc(license_number);
    const customer_ref = Firestore().collection("customers").doc(customer_uid);
    try {
      // Get car_owners.
      let car_owners = await car_owners_ref.get();

      // Customer's Car - on delete.
      // DO: remove customer_ref from car_owners.
      if (old_car && !new_car) {
        if (car_owners.exists) {
          const data = car_owners.data() as CarOwners;
          // CASE: car_owners have more than one owner.
          // DO: remove customer_ref from car_onwers.
          if (data.owners.length > 1)
            await car_owners_ref.update({
              owners: FieldValue.arrayRemove(customer_ref),
            });
          // CASE: car_owners have one or zero owner.
          // DO: remove car_owners.
          else await car_owners_ref.delete();
        }

        // Call bot to notify customer.
        await BOT({
          url: "/car/remove",
          data: {
            target: customer_uid,
            license_number: old_car.license_number,
            province: old_car.province,
          },
        });
      }

      // Customer's Car - on create.
      // DO: add customer_ref to car_owners.
      if (!old_car && new_car) {
        // CASE: car_owners not exist.
        // DO: create car_owners with customer_ref.
        if (!car_owners.exists)
          await car_owners_ref.set({
            license_number: license_number,
            owners: [customer_ref],
          } as CarOwners);
        // CASE: car_onwers exist.
        // DO: add customer_ref to car_owners.
        else
          await car_owners_ref.update({
            owners: FieldValue.arrayUnion(customer_ref),
          });

        // Call bot to notify customer.
        await BOT({
          url: "/car/add",
          data: {
            target: customer_uid,
            license_number: new_car.license_number,
            province: new_car.province,
          },
        });
      }

      return null;
    } catch (e) {
      console.error(e);
      return null;
    }
  });
