import * as functions from "firebase-functions";
import { Firestore } from "..";
import {
  DocumentReference,
  DocumentData,
  FieldValue,
} from "@google-cloud/firestore";
import axios, { AxiosError } from "axios";

// [Type/Function]
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

// > Initializes modules.
const APP_SECRET = process.env.APP_SECRET as string;
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

// > Customer's cars write. (Firestore.onWrite)
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
      // Get car's owners.
      let car_owners_get = await car_owners_ref.get();
      let car_owners = car_owners_get.exists
        ? (car_owners_get.data() as CarOwners)
        : null;

      // CASE: on delete.
      // DO: remove customer from car_owners.
      if (old_car && !new_car) {
        // CASE: has car's owners.
        if (car_owners)
          if (car_owners.owners.length > 1)
            // CASE: car's owners have more than one owner.
            // DO: remove customer from car's onwers.
            await car_owners_ref.update({
              owners: FieldValue.arrayRemove(customer_ref),
            });
          // DO: remove car's owners.
          else await car_owners_ref.delete();

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

      // CASE: on create.
      // DO: add customer to car's owners.
      if (!old_car && new_car) {
        // CASE: car's owners not exist.
        // DO: create car's owners with customer.
        if (!car_owners)
          await car_owners_ref.set({
            license_number: license_number,
            owners: [customer_ref],
          } as CarOwners);
        // DO: add customer to car's owners.
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
