import * as functions from "firebase-functions";
import {
  Timestamp,
  DocumentReference,
  DocumentData,
  FieldValue,
} from "@google-cloud/firestore";
import { Firestore, RTDatabase } from "../firebase";
import moment = require("moment-timezone");
import axios, { AxiosError } from "axios";
import NodeCache = require("node-cache");
import stripe from "stripe";

// [Secret]
const APP_SECRET = process.env.APP_SECRET as string;
const STRIPE_SECRET = process.env.STRIPE_SECRET as string;
const STRIPE_ENDPOINT_SECRET = process.env.STRIPE_ENDPOINT_SECRET as string;

// [Stripe]
const Stripe = new stripe(STRIPE_SECRET, { apiVersion: "2022-11-15" });

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

// [Payment]
type PaymentStatus =
  | "Pending"
  | "Success"
  | "Failed"
  | "Process"
  | "Refund"
  | "Canceled";

type Payment = {
  [index: string]:
    | string
    | number
    | Timestamp
    | DocumentReference<DocumentData>
    | boolean
    | undefined;
  pid: string;
  client_secret: string;
  amount: number;
  timestamp: Timestamp;
  status: PaymentStatus;
  reason?: string;
  paid_by?: DocumentReference<DocumentData>;
  is_edit?: boolean;
};

// [Transaction]
type TransactionStatus = "Unpaid" | "Paid" | "Cancel";

type Transaction = {
  [index: string]:
    | string
    | number
    | boolean
    | null
    | Timestamp
    | Array<Payment>
    | undefined;
  tid: string;
  license_number: string;
  timestamp_in: Timestamp;
  image_in?: string;
  fee: number;
  status: TransactionStatus;
  paid: number;
  timestamp_out: Timestamp | null;
  image_out?: string;
  remark: string;
  add_by?: string;
  is_overnight?: boolean;
  is_cancel?: boolean;
  is_edit?: boolean;
  has_image?: boolean;
};

// [Cars]
type CarCustomers = {
  license_number: string;
  owners: Array<DocumentReference<DocumentData>>;
};

// [Caches]
const cache = new NodeCache({ useClones: false });

const calculateFee = async (
  time_in: Timestamp,
  time_out: Timestamp | null
): Promise<number> => {
  // Load fee if no FEE_PER_DAY
  if (!cache.has("FEE_PER_DAY")) {
    const fee_ref = await RTDatabase().ref("settings/fee").get();
    const fee = typeof fee_ref.val() === "number" ? fee_ref.val() : 0;
    cache.set<number>("FEE_PER_DAY", fee, 3600);
  }
  const FEE_PER_DAY = cache.get<number>("FEE_PER_DAY") as number;
  // Convert Timestamp to Date
  let timestamp_in = moment(time_in.toDate())
    .tz("Asia/Bangkok")
    .hour(0)
    .minute(0)
    .second(0)
    .millisecond(0)
    .add(1, "day");

  let timestamp_out = moment(time_out ? time_out.toDate() : new Date())
    .tz("Asia/Bangkok")
    .hour(23)
    .minutes(59)
    .seconds(59)
    .millisecond(999);
  // Add Fee.
  let fee = FEE_PER_DAY;
  while (timestamp_in.isBefore(timestamp_out)) {
    fee += FEE_PER_DAY;
    timestamp_in = timestamp_in.add(1, "day");
  }
  if (fee === 0) fee = FEE_PER_DAY;
  return fee;
};

const isValidTimestamp = (
  time_in: Timestamp,
  time_out: Timestamp | null
): boolean => {
  const timestamp_in = moment(time_in.toDate());
  const timestamp_out = moment(time_out ? time_out.toDate() : new Date());
  return timestamp_in.isBefore(timestamp_out);
};

const transactionStatus = (
  fee: number,
  paid: number,
  is_cancel: boolean | undefined
): TransactionStatus => {
  return !is_cancel ? (fee <= paid ? "Paid" : "Unpaid") : "Cancel";
};

const timestampToString = (input: Timestamp) => {
  return moment(input.toDate())
    .tz("Asia/Bangkok")
    .format("DD/MM/YYYY HH:mm:ss");
};

// [Function]
// F - Event on "transactions" being write.
exports.onTransactionsWrite = functions
  .region("asia-southeast2")
  .runWith({ timeoutSeconds: 300 })
  .firestore.document("/transactions/{tid}")
  .onWrite(async (changes, context) => {
    // Format parameters.
    const tid: string = context.params.tid;
    const old_transaction: Transaction | null = changes.before.exists
      ? (changes.before.data() as Transaction)
      : null;
    const new_transaction: Transaction | null = changes.after.exists
      ? (changes.after.data() as Transaction)
      : null;
    try {
      // Transaction - on create.
      // DO: add tid, status, fee, paid.
      if (!old_transaction && new_transaction) {
        // Format new transaction.
        const transaction: Transaction = {
          ...new_transaction,
          status: "Unpaid",
          tid: tid,
          fee: await calculateFee(
            new_transaction.timestamp_in,
            new_transaction.timestamp_out
          ),
          paid: 0,
          timestamp_out: null,
          remark: "",
        };

        // Call bot to notify customer.
        await BOT({
          url: "/transaction/entrance",
          data: {
            tid: transaction.tid,
            license_number: transaction.license_number,
            timestamp_in: timestampToString(transaction.timestamp_in),
            fee: transaction.fee,
            image_in: transaction.image_in,
          },
        });

        return changes.after.ref.set(transaction);
      }

      // CASE: already initialize.
      // DO: terminate database call.
      if (!old_transaction?.tid && new_transaction?.tid) return null;

      // Transaction - on update.
      // DO: change transaction's data.
      /*
        Allow Changes:
          license_number  -   (no condition)
          timestamp_in    -   (condition)
          timestamp_out   -   (condition)
          image_in        -   (no condition)
          image_out       -   (condition)
          is_cancel       -   (condition)
          remark          -   (no condition)
      */
      if (old_transaction && new_transaction) {
        // CASE: already update or not update by user.
        // DO: terminate database call.
        if (!(!old_transaction.is_edit && new_transaction.is_edit)) return null;

        // CASE: transaction has been cancel.
        // DO: revert changes.
        if (old_transaction.is_cancel)
          return changes.before.ref.set(changes.before.data() as Transaction);

        // Format changes.
        const license_number_change =
          old_transaction.license_number !== new_transaction.license_number;
        const timestamp_in_change =
          old_transaction.timestamp_in !== new_transaction.timestamp_in;
        const timestamp_out_change =
          old_transaction.timestamp_out !== new_transaction.timestamp_out;
        const image_in_change =
          old_transaction.image_in !== new_transaction.image_in;
        const image_out_change =
          old_transaction.image_out !== new_transaction.image_out;
        const is_cancel_change =
          old_transaction.is_cancel !== new_transaction.is_cancel;
        const remark_change = old_transaction.remark !== new_transaction.remark;
        const allow_changes =
          license_number_change ||
          timestamp_in_change ||
          timestamp_out_change ||
          image_in_change ||
          image_out_change ||
          is_cancel_change ||
          remark_change ||
          new_transaction.is_overnight;

        // CASE: no allow changes.
        // DO: revert changes.
        if (!allow_changes)
          return changes.before.ref.set(changes.before.data() as any);

        // Format draft transaction.
        let transaction: Transaction = { ...old_transaction };

        // No condition fields
        if (license_number_change)
          transaction.license_number = new_transaction.license_number;
        if (image_in_change) transaction.image_in = new_transaction.image_in;
        if (remark_change) transaction.remark = new_transaction.remark;

        // Timestamp fields
        // DO: check validity and re-calculate fee, status, is_overnight based on timestamps.
        // CONDITION: timestamp_in is before timestamp_out.
        // CASE: timestamp_in and timestamp_out are change.
        if (timestamp_in_change && timestamp_out_change) {
          if (
            isValidTimestamp(
              new_transaction.timestamp_in,
              new_transaction.timestamp_out
            )
          ) {
            const new_fee = await calculateFee(
              new_transaction.timestamp_in,
              new_transaction.timestamp_out
            );
            transaction = {
              ...transaction,
              timestamp_in: new_transaction.timestamp_in,
              timestamp_out: new_transaction.timestamp_out,
              fee: new_fee,
              status: transactionStatus(
                new_fee,
                transaction.paid,
                transaction.is_cancel
              ),
            };
          }
        }
        // CASE: timestamp_in is change.
        else if (timestamp_in_change) {
          if (
            isValidTimestamp(
              new_transaction.timestamp_in,
              transaction.timestamp_out
            )
          ) {
            const new_fee = await calculateFee(
              new_transaction.timestamp_in,
              transaction.timestamp_out
            );
            transaction = {
              ...transaction,
              timestamp_in: new_transaction.timestamp_in,
              fee: new_fee,
              status: transactionStatus(
                new_fee,
                transaction.paid,
                transaction.is_cancel
              ),
            };
          }
        }
        // CASE: timestamp_out is change.
        else if (timestamp_out_change) {
          if (
            isValidTimestamp(
              transaction.timestamp_in,
              new_transaction.timestamp_out
            )
          ) {
            const new_fee = await calculateFee(
              transaction.timestamp_in,
              new_transaction.timestamp_out
            );
            if (new_fee === transaction.paid)
              transaction = {
                ...transaction,
                timestamp_out: new_transaction.timestamp_out,
                fee: new_fee,
                status: transactionStatus(
                  new_fee,
                  transaction.paid,
                  transaction.is_cancel
                ),
              };
            else
              transaction = {
                ...transaction,
                fee: new_fee,
                status: transactionStatus(
                  new_fee,
                  transaction.paid,
                  transaction.is_cancel
                ),
              };
          }
        }

        // Image out field
        // CONDITION: timestamp_out is not undefined.
        if (image_out_change && transaction.timestamp_out)
          if (transaction.fee === transaction.paid)
            transaction = {
              ...transaction,
              image_out: new_transaction.image_out,
            };

        // Is cancel field
        // CONDITION: all paid money refunded and status is "Unpaid".
        if (
          is_cancel_change &&
          transaction.paid === 0 &&
          transaction.status === "Unpaid"
        )
          transaction = { ...transaction, is_cancel: true, status: "Cancel" };

        // Is overnight field.
        // DO: calculate new fee.
        if (new_transaction.is_overnight) {
          const new_fee = await calculateFee(
            transaction.timestamp_in,
            transaction.timestamp_out
          );
          transaction = {
            ...transaction,
            fee: new_fee,
            status: transactionStatus(
              new_fee,
              transaction.paid,
              transaction.is_cancel
            ),
          };
        }

        // Update payment amount if there is pending payment.
        if (old_transaction.fee !== transaction.fee) {
          // Fetch pending payments.
          const pending_payments_ref = await Firestore()
            .collection("transactions")
            .doc(tid)
            .collection("payments")
            .where("status", "==", "Pending")
            .get();

          // CASE: pending payments is more than 0.
          if (pending_payments_ref.size > 0) {
            const fee_diff_amount = transaction.fee - old_transaction.fee;
            // CASE: add amount
            // DO: update amount.
            if (fee_diff_amount > 0 && transaction.fee > transaction.paid)
              await Stripe.paymentIntents.update(
                pending_payments_ref.docs[0].id,
                {
                  amount: (transaction.fee - transaction.paid) * 100,
                }
              );
            // DO: cancel payment.
            else
              await Stripe.paymentIntents.cancel(
                pending_payments_ref.docs[0].id,
                { cancellation_reason: "abandoned" }
              );
          }
        }

        // Check changed on notifications.
        const bot_action: string | null =
          transaction.status === "Cancel"
            ? "cancel"
            : transaction.timestamp_out && transaction.status === "Paid"
            ? "exit"
            : new_transaction.is_overnight
            ? "overnight"
            : new_transaction.license_number !== transaction.license_number ||
              new_transaction.timestamp_in !== transaction.timestamp_in ||
              new_transaction.timestamp_out !== transaction.timestamp_out ||
              new_transaction.fee !== transaction.fee
            ? "update"
            : null;

        // Call bot to notify customer.
        if (bot_action)
          await BOT({
            url: `/transaction/${bot_action}`,
            data: {
              tid: transaction.tid,
              license_number: transaction.license_number,
              timestamp_in: timestampToString(transaction.timestamp_in),
              timestamp_out: transaction.timestamp_out
                ? timestampToString(transaction.timestamp_out)
                : undefined,
              fee: transaction.fee,
              image_in: transaction.image_in,
              image_out: transaction.image_out,
            },
          });

        // Set update and remove is_edit.
        return changes.after.ref.set(
          new_transaction.is_overnight
            ? {
                ...transaction,
                is_overnight: FieldValue.delete(),
                is_edit: FieldValue.delete(),
              }
            : {
                ...transaction,
                is_edit: FieldValue.delete(),
              },
          { merge: true }
        );
      }

      // Transaction - on delete.
      // DO: no change,
      return null;
    } catch (e) {
      // CASE: Error.
      // DO: reverse changes.
      console.error(e);
      return changes.before.ref.set(
        old_transaction ? old_transaction : (new_transaction as Transaction)
      );
    }
  });

// F - Event on "transactions/payments" being write.
exports.onTransactionsPaymentsWrite = functions
  .region("asia-southeast2")
  .runWith({ timeoutSeconds: 300 })
  .firestore.document("/transactions/{tid}/payments/{pid}")
  .onWrite(async (changes, context) => {
    // Format parameters.
    const tid: string = context.params.tid;
    const old_payment: Payment | null = changes.before.exists
      ? (changes.before.data() as Payment)
      : null;
    const new_payment: Payment | null = changes.after.exists
      ? (changes.after.data() as Payment)
      : null;
    const transaction_ref = Firestore().collection("transactions").doc(tid);
    try {
      // Get transaction.
      const transaction: Transaction = (
        await transaction_ref.get()
      ).data() as Transaction;

      // CASE: already initialize.
      // DO: terminate database call.
      if (!old_payment?.pid && new_payment?.pid) return null;

      // CASE: update client_secret.
      // DO: terminate database call.
      if (!old_payment?.client_secret && new_payment?.client_secret)
        return null;

      // CASE: Cancel payment.
      // DO: terminate database call.
      if (new_payment?.status === "Canceled") return null;

      // Payment - on update.
      // DO: Set "Status to Approve, Reject, or Refunded"
      /*
        Allow Status Change:
          Pending -> Success
          Pending -> Failed
          Pending -> Canceled
          Approve -> Refund
      */
      if (old_payment && new_payment) {
        // CASE: already update or not update user.
        // DO: terminate database call.
        if (!(!old_payment.is_edit && new_payment.is_edit)) return null;

        // Format changes.
        const pending_success =
          old_payment.status === "Pending" && new_payment.status === "Success";
        const pending_failed =
          old_payment.status === "Pending" && new_payment.status === "Failed";
        const pending_process =
          old_payment.status === "Pending" && new_payment.status === "Process";
        const process_success =
          old_payment.status === "Process" && new_payment.status === "Success";
        const process_failed =
          old_payment.status === "Process" && new_payment.status === "Failed";
        const success_refund =
          old_payment.status === "Success" && new_payment.status === "Refund";
        const allow_change =
          pending_success ||
          pending_failed ||
          pending_process ||
          process_success ||
          process_failed ||
          success_refund;

        // CASE: no allow changes.
        // DO: reverse changes.
        if (!allow_change)
          return changes.before.ref.set(changes.before.data() as any);

        // CASE: Refund.
        if (success_refund) {
          // Set transaction.
          const new_paid =
            transaction.paid > 0 ? transaction.paid - old_payment.amount : 0;
          await transaction_ref.update({
            paid: new_paid,
            status: transactionStatus(
              transaction.fee,
              new_paid,
              transaction.is_cancel
            ),
          });
        }

        // CASE: Success
        if (pending_success || process_success) {
          const new_paid = transaction.paid + old_payment.amount;
          await transaction_ref.update({
            paid: new_paid,
            status: transactionStatus(
              transaction.fee,
              new_paid,
              transaction.is_cancel
            ),
          });
        }

        // Call bot to notify customer.
        // CASE: have payer and change to "Success" | "Failed" | "Refund"
        // DO: call bot.
        if (
          new_payment.paid_by &&
          (new_payment.status === "Success" ||
            new_payment.status === "Failed" ||
            new_payment.status === "Refund")
        ) {
          await BOT({
            url: `/payment/${
              new_payment.status === "Success"
                ? "receive"
                : new_payment.status === "Failed"
                ? "reject"
                : "refund"
            }`,
            data: {
              target: new_payment.paid_by.id,
              amount: new_payment.amount,
              timestamp: timestampToString(new_payment.timestamp),
              pid: new_payment.pid,
              tid: tid,
            },
          });
        }

        // Set status then remove is_edit.
        return changes.after.ref.update({
          status: new_payment.status,
          reason: new_payment.reason,
          is_edit: FieldValue.delete(),
        });
      }
      // Payment - on delete.
      // DO: no change.
      return null;
    } catch (e) {
      console.error(e);
      return null;
    }
  });

// F - Warning in-system transaction.
exports.warningInSystemTransaction = functions
  .region("asia-southeast2")
  .runWith({ timeoutSeconds: 300 })
  .pubsub.schedule("0 20 * * *")
  .timeZone("Asia/Bangkok")
  .onRun(async (context) => {
    // Fetch in-system transactions.
    const transaction_refs = await Firestore()
      .collection("transactions")
      .where("timestamp_out", "==", null)
      .get();
    const transactions = transaction_refs.docs.map(
      (doc) => doc.data() as Transaction
    );

    if (transaction_refs.size === 0)
      return console.log("No in-system transaction.");

    // Find in-system transactions.
    let targets = new Set<string>();
    let license_numbers = new Set<string>();
    for (let transaction of transactions) {
      // CASE: transaction already closed.
      // DO: ignore transaction.
      if (transaction.timestamp_out) continue;

      // CASE: already add license number's target.
      // DO: ignore transaction.
      if (license_numbers.has(transaction.license_number)) continue;

      // Add owners.
      const car_ref = await Firestore()
        .collection("cars")
        .doc(transaction.license_number)
        .get();
      const car = car_ref.exists ? (car_ref.data() as CarCustomers) : null;

      // CASE: car founded.
      // DO: add owners into target.
      if (car) car.owners.forEach((owner) => targets.add(owner.id));

      license_numbers.add(transaction.license_number);
    }

    // Call bot if has targets.
    if (targets.size > 0)
      await BOT({
        url: `/transaction/warning`,
        data: {
          targets: Array.from(targets),
        },
      });

    console.log(
      `Send warning notifications successfully. (${targets.size} target${
        targets.size > 1 ? "s" : ""
      }.)`
    );
  });

// F - Re-calculate in-system transaction's fee.
exports.reCalculateInSystemTransactionFee = functions
  .region("asia-southeast2")
  .runWith({ timeoutSeconds: 300 })
  .pubsub.schedule("0 5 * * *")
  .timeZone("Asia/Bangkok")
  .onRun(async (context) => {
    // Fetch all transactions
    const transaction_refs = await Firestore()
      .collection("transactions")
      .where("timestamp_out", "==", null)
      .get();
    const transactions = transaction_refs.docs.map(
      (doc) => doc.data() as Transaction
    );

    // Update overnight transactions.
    let count = 0;
    for (let transaction of transactions) {
      // CASE: transaction already closed.
      // DO: ignore transaction.
      if (transaction.timestamp_out) continue;

      await Firestore()
        .collection("transactions")
        .doc(transaction.tid)
        .update({ is_overnight: true, is_edit: true });
      count++;
    }

    console.log(
      `Recalculate fee in-system transactions successfully. (${count} transaction${
        count > 1 ? "s" : ""
      })`
    );
  });

// F - On Fee Write
exports.onFeeWrtie = functions
  .region("asia-southeast2")
  .runWith({ timeoutSeconds: 300 })
  .database.ref("/settings/fee")
  .onWrite(async (snapshot, context) => {
    // CASE: new change exist and is number.
    // DO: update fee in cache.
    if (snapshot.after.exists() && typeof snapshot.after.val() === "number") {
      cache.set<number>("FEE_PER_DAY", snapshot.after.val(), 3600);
    }
  });

// F - Create Payment
exports.createPayment = functions
  .region("asia-southeast2")
  .runWith({ timeoutSeconds: 300 })
  .https.onCall(async (tid: string, context) => {
    // CASE: no tid.
    // DO: throw invalid-argument.
    if (!tid)
      throw new functions.https.HttpsError("invalid-argument", "no tid.");

    // Fetch transaction.
    const t_ref = Firestore().collection("transactions").doc(tid);
    const transaction = (await t_ref.get()).data() as Transaction | null;

    // CASE: no transaction.
    // DO: throw invalid-argument.
    if (!transaction)
      throw new functions.https.HttpsError("invalid-argument", "invalid tid.");

    // CASE: transaction is paid.
    // DO: throw invalid-argument.
    if (transaction.status === "Paid")
      throw new functions.https.HttpsError(
        "invalid-argument",
        "transaction is paid."
      );

    // Fetch pending payments in the transaction.
    const transaaction_payments_ref = t_ref.collection("payments");
    const pending_payments = await transaaction_payments_ref
      .where("status", "==", "Pending")
      .get();

    // CASE: there are pending payments in transaction.
    // DO: return the first payment intent.
    if (pending_payments.size > 0) {
      const payment = pending_payments.docs[0].data() as Payment;
      return payment.pid;
    }

    // Create Payment Intent.
    const paymentIntent = await Stripe.paymentIntents.create({
      amount: (transaction.fee - transaction.paid) * 100,
      currency: "thb",
      payment_method_types: ["promptpay"],
      description: `Parking fee of ${transaction.license_number} on ${moment(
        transaction.timestamp_in
      )
        .tz("Asia/Bangkok")
        .format("DD/MM/YYYY HH:mm:ss")}.`,
      metadata: {
        tid: transaction.tid,
      },
    });

    // Create payment.
    const payment_ref = transaaction_payments_ref.doc(paymentIntent.id);
    await payment_ref.set({
      amount: transaction.fee - transaction.paid,
      timestamp: FieldValue.serverTimestamp(),
      pid: paymentIntent.id,
      status: "Pending",
      client_secret: paymentIntent.client_secret,
      paid_by: context.auth?.token.line
        ? Firestore().collection("customers").doc(context.auth.uid)
        : undefined,
    });

    return payment_ref.id;
  });

exports.webhook = functions
  .region("asia-southeast2")
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    // CASE: method is not "POST".
    // DO: throw not found.
    if (req.method !== "POST") {
      res.sendStatus(404);
      return;
    }

    let event = req.body as stripe.Event;
    // Verify endpoint secret.
    if (STRIPE_ENDPOINT_SECRET) {
      // Get signature.
      const signature = req.headers["stripe-signature"];
      try {
        if (!signature) throw new Error();
        event = Stripe.webhooks.constructEvent(
          req.rawBody,
          signature,
          STRIPE_ENDPOINT_SECRET
        );
      } catch (err) {
        console.log("Cannot verify webhook signature.");
        res.sendStatus(400);
        return;
      }
    }

    const object = event.data.object as stripe.PaymentIntent;
    const tid = object.metadata.tid;
    const pid = object.id;
    // Handle event.
    switch (event.type) {
      case "payment_intent.succeeded":
        // Update payment success.
        if (tid && pid) {
          await Firestore()
            .collection("transactions")
            .doc(tid)
            .collection("payments")
            .doc(pid)
            .update({ status: "Success", is_edit: true });
        } else {
          console.log(`Cannot extract tid or pid. (${event.type})`);
        }
        break;
      case "payment_intent.processing":
        // Update payment success.
        if (tid && pid) {
          await Firestore()
            .collection("transactions")
            .doc(tid)
            .collection("payments")
            .doc(pid)
            .update({ status: "Process", is_edit: true });
        } else {
          console.log(`Cannot extract tid or pid. (${event.type})`);
        }
        break;
      case "payment_intent.canceled":
        if (tid && pid) {
          await Firestore()
            .collection("transactions")
            .doc(tid)
            .collection("payments")
            .doc(pid)
            .update({
              status: "Canceled",
              reason: object.cancellation_reason,
            });
        } else {
          console.log(`Cannot extract tid or pid. (${event.type})`);
        }
        break;
      case "payment_intent.payment_failed":
        // Update payment success.
        if (tid && pid) {
          await Firestore()
            .collection("transactions")
            .doc(tid)
            .collection("payments")
            .doc(pid)
            .update({
              status: "Failed",
              reason: object.last_payment_error?.code,
              is_edit: true,
            });
        } else {
          console.log(`Cannot extract tid or pid. (${event.type})`);
        }
        break;
      default:
    }

    // Return 200.
    res.send();
  });
