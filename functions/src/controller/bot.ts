import * as functions from "firebase-functions";
import * as line from "@line/bot-sdk";
import { NextFunction, Request, Response } from "express";
import express = require("express");
import cors = require("cors");
import NodeCache = require("node-cache");
import { Firestore } from "../firebase";
import { DocumentData, DocumentReference } from "firebase-admin/firestore";
import { Message } from "@line/bot-sdk";

// [Secret]
const APP_SECRET = process.env.APP_SECRET;

// [LIFF]
const LIFF_URI = process.env.LIFF_URI;

// [Messaging API]
const MESSAGING_API_CONFIG = {
  channelAccessToken:
    "OTRkdQJglg6b9kk7Xm9xzgI2yXahjGG4cRMAgqU/tk8GWKmxP6fx760tIMSihsPjZOAmYaM9ygT67qxIIntkbTA/IJYFcR/t7yR2Xb5Bl5Wj0I34o5V8AadGsD8JdXnWHQ1BBqnFrKmldxPEYAIUcgdB04t89/1O/w1cDnyilFU=",
  channelSecret: process.env.LINE_MESSAGING_API_CHANNEL_SECRET,
};
// @ts-ignore
const LINE = new line.Client(MESSAGING_API_CONFIG);

// [Cars]
type CarCustomers = {
  license_number: string;
  owners: Array<DocumentReference<DocumentData>>;
};

// [Caches]
const cars = new NodeCache({ stdTTL: 1800, useClones: false }); // TTL - 30 minutes.

// [Template]
const Template = {
  welcomeMessage: (displayName: string): Message => ({
    type: "flex",
    altText: `Welcome ${displayName}. This is an official LINE account of AU Parking. To use the service, please add your cars' information to receive notifications of transactions.`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: `Welcome ${displayName}`,
            weight: "bold",
            align: "center",
            color: "#E9202D",
            size: "xl",
            margin: "none",
          },
        ],
        paddingTop: "xxl",
        paddingBottom: "xxl",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "This is an official LINE account of AU Parking.",
            wrap: true,
          },
          {
            type: "text",
            text: "To use the service, please add your cars' information to receive notifications.",
            wrap: true,
          },
        ],
        paddingTop: "xxl",
        paddingBottom: "xxl",
        spacing: "lg",
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: {
              type: "uri",
              label: "Add Car",
              uri: `${LIFF_URI}/car`,
            },
            color: "#E9202D",
            style: "primary",
            height: "sm",
          },
        ],
        paddingTop: "lg",
        paddingBottom: "lg",
      },
      styles: {
        body: {
          separator: true,
        },
        footer: {
          separator: true,
        },
      },
      size: "kilo",
    },
  }),
  warningInSystemTransactions: (): Message => ({
    type: "flex",
    altText:
      "There are transactions remaining in the system. Please take your cars out before midnight to avoid penalty charged.",
    contents: {
      type: "bubble",
      size: "kilo",
      hero: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "WARNING",
            size: "lg",
            color: "#FFFFFF",
            weight: "bold",
            align: "center",
          },
        ],
        paddingTop: "lg",
        paddingBottom: "lg",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "There are transactions remaining in the system. Please take your cars out before midnight to avoid penalty charged.",
            wrap: true,
            align: "start",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: {
              type: "uri",
              label: "View Transactions",
              uri: `${LIFF_URI}/transaction`,
            },
            height: "sm",
          },
        ],
      },
      styles: {
        hero: {
          backgroundColor: "#eab308",
        },
        body: {
          separator: true,
        },
        footer: {
          separator: true,
        },
      },
    },
  }),
  invalidCommand: (): Message => ({
    type: "flex",
    altText:
      "If you want to chat with our staffs, please create a report first. Sooner, staff will be here to help you through chats.",
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "If you want to chat with our staffs, please create a report first. Sooner, staff will be here to help you through chats.",
            wrap: true,
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: {
              type: "uri",
              label: "Create Report",
              uri: `${LIFF_URI}/report/create`,
            },
            color: "#E9202D",
            style: "primary",
            height: "sm",
          },
        ],
      },
      styles: {
        footer: {
          separator: true,
        },
      },
    },
  }),
  carNotification: (
    type: string,
    data: { license_number: string; province: string }
  ): Message => ({
    type: "flex",
    altText: `${data.license_number} ${data.province} has been ${
      type === "add" ? "added to" : "removed from"
    } your account.`,
    contents: {
      type: "bubble",
      hero: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "text",
                text: type === "add" ? "Car Added" : "Car Removed",
                weight: "bold",
                color: "#FFFFFF",
              },
            ],
            backgroundColor: "#E9202D",
            paddingTop: "sm",
            paddingBottom: "sm",
            paddingStart: "lg",
            paddingEnd: "lg",
            offsetTop: "lg",
            offsetStart: "lg",
            position: "absolute",
            cornerRadius: "xxl",
          },
        ],
        height: "53px",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "text",
                text: data.license_number,
                size: "xxl",
                align: "center",
                weight: "bold",
                color: "#000000",
              },
              {
                type: "text",
                text: data.province,
                weight: "bold",
                align: "center",
                size: "lg",
                color: "#000000",
              },
            ],
            spacing: "md",
            borderWidth: "medium",
            borderColor: "#000000",
            paddingTop: "xl",
            paddingBottom: "xl",
            cornerRadius: "lg",
          },
        ],
      },
      size: "kilo",
      styles: {
        body: {
          separator: true,
        },
      },
    },
  }),
  transactionNotification: (
    type: string,
    data: {
      tid: string;
      license_number: string;
      timestamp_in: string;
      timestamp_out: string | undefined;
      fee: number;
      image_in: string | undefined;
      image_out: string | undefined;
    }
  ): Message => ({
    type: "flex",
    altText:
      type === "entrance"
        ? `${data.license_number} has entered the parking building on ${data.timestamp_in}.`
        : type === "exit"
        ? `${data.license_number} has exited the parking building on ${data.timestamp_out}.`
        : type === "overnight"
        ? `${data.license_number} on ${
            data.timestamp_in
          } has been charged due to overnight transaction. The new fee is ฿ ${data.fee.toFixed(
            2
          )}.`
        : type === "update"
        ? `${data.license_number} on ${data.timestamp_in} has been updated.`
        : `${data.license_number} on ${data.timestamp_in} has been cancelled.`,
    contents: {
      type: "bubble",
      hero:
        ["entrance", "cancel", "overnight", "update"].includes(type) &&
        data.image_in
          ? {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "image",
                  url: data.image_in,
                  size: "full",
                  aspectRatio: "16:10",
                  aspectMode: "cover",
                },
                {
                  type: "box",
                  layout: "vertical",
                  contents: [
                    {
                      type: "text",
                      text: `${type.charAt(0).toUpperCase() + type.slice(1)}`,
                      color: "#FFFFFF",
                      weight: "bold",
                    },
                  ],
                  backgroundColor:
                    type === "entrance"
                      ? "#E9202D"
                      : type === "overnight"
                      ? "#eab308"
                      : type === "update"
                      ? "#22c55e"
                      : "#6b7280",
                  paddingTop: "sm",
                  paddingBottom: "sm",
                  paddingStart: "lg",
                  paddingEnd: "lg",
                  position: "absolute",
                  offsetTop: "lg",
                  cornerRadius: "xxl",
                  offsetStart: "lg",
                },
              ],
            }
          : type === "exit" && data.image_out
          ? {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "image",
                  url: data.image_out,
                  size: "full",
                  aspectRatio: "16:10",
                  aspectMode: "cover",
                },
                {
                  type: "box",
                  layout: "vertical",
                  contents: [
                    {
                      type: "text",
                      text: `${type.charAt(0).toUpperCase() + type.slice(1)}`,
                      color: "#FFFFFF",
                      weight: "bold",
                    },
                  ],
                  backgroundColor: "#E9202D",
                  paddingTop: "sm",
                  paddingBottom: "sm",
                  paddingStart: "lg",
                  paddingEnd: "lg",
                  position: "absolute",
                  offsetTop: "lg",
                  cornerRadius: "xxl",
                  offsetStart: "lg",
                },
              ],
            }
          : {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "box",
                  layout: "vertical",
                  contents: [
                    {
                      type: "text",
                      text: `${type.charAt(0).toUpperCase() + type.slice(1)}`,
                      color: "#FFFFFF",
                      weight: "bold",
                    },
                  ],
                  backgroundColor: ["entrance", "exit"].includes(type)
                    ? "#E9202D"
                    : type === "overnight"
                    ? "#eab308"
                    : type === "update"
                    ? "#22c55e"
                    : "#6b7280",
                  paddingTop: "sm",
                  paddingBottom: "sm",
                  paddingStart: "lg",
                  paddingEnd: "lg",
                  position: "absolute",
                  offsetTop: "lg",
                  cornerRadius: "xxl",
                  offsetStart: "lg",
                },
              ],
              height: "53px",
            },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: data.license_number,
            size: "xxl",
            weight: "bold",
            color: "#E9202D",
          },
          {
            type: "text",
            margin: "xs",
            color: "#71717a",
            size: "sm",
            contents: [
              {
                type: "span",
                text: "TID: ",
                weight: "bold",
              },
              {
                type: "span",
                text: data.tid,
              },
            ],
          },
          {
            type: "separator",
            margin: "md",
          },
          {
            type: "text",
            margin: "md",
            color: "#71717a",
            size: "md",
            contents: [
              {
                type: "span",
                text: "In: ",
                weight: "bold",
              },
              {
                type: "span",
                text: data.timestamp_in,
              },
            ],
          },
          data.timestamp_out
            ? {
                type: "text",
                margin: "md",
                color: "#71717a",
                size: "md",
                contents: [
                  {
                    type: "span",
                    text: "Out: ",
                    weight: "bold",
                  },
                  {
                    type: "span",
                    text: data.timestamp_out,
                  },
                ],
              }
            : {
                type: "filler",
              },
          {
            type: "text",
            color: "#71717a",
            margin: "sm",
            size: "md",
            contents: [
              {
                type: "span",
                text: "Fee: ",
                weight: "bold",
              },
              {
                type: "span",
                text: `฿ ${data.fee.toFixed(2)}`,
              },
            ],
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          type === "exit"
            ? {
                type: "button",
                action: {
                  type: "uri",
                  label: "View Transaction",
                  uri: `${LIFF_URI}/transaction/${data.tid}`,
                },
                height: "sm",
              }
            : {
                type: "button",
                action: {
                  type: "uri",
                  label: "Pay",
                  uri: `${LIFF_URI}/payment/${data.tid}`,
                },
                color: "#E9202D",
                height: "sm",
                style: "primary",
              },
        ],
      },
      styles: {
        body: {
          separator: true,
        },
        footer: {
          separator: true,
        },
      },
      size: "kilo",
    },
  }),
  paymentNotification: (
    type: string,
    data: { amount: number; timestamp: string; pid: string; tid: string }
  ): Message => ({
    type: "flex",
    altText: `${
      type === "receive"
        ? "Received"
        : type === "reject"
        ? "Rejected"
        : "Refunded"
    } ฿ ${data.amount.toFixed(2)} on ${data.timestamp}.`,
    contents: {
      type: "bubble",
      hero: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "text",
                text: "Payment",
                color: "#FFFFFF",
                weight: "bold",
              },
            ],
            position: "absolute",
            backgroundColor: "#E9202D",
            paddingTop: "sm",
            paddingBottom: "sm",
            paddingStart: "lg",
            paddingEnd: "lg",
            cornerRadius: "xxl",
            offsetTop: "lg",
            offsetStart: "lg",
          },
        ],
        paddingStart: "xl",
        paddingEnd: "xl",
        paddingTop: "md",
        paddingBottom: "md",
        height: "53px",
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "text",
                text: `฿ ${data.amount.toFixed(2)}`,
                weight: "bold",
                size: "xxl",
                color:
                  type === "receive"
                    ? "#22c55e"
                    : type === "reject"
                    ? "#E9202D"
                    : "#6b7280",
              },
              {
                type: "text",
                text: `Payment ${
                  type === "receive" ? "received" : `${type}ed`
                }.`,
              },
              {
                type: "text",
                text: data.timestamp,
                margin: "md",
                color: "#6b7280",
              },
            ],
          },
          {
            type: "separator",
          },
          {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "PID:",
                    flex: 0,
                    weight: "bold",
                    size: "sm",
                    color: "#6b7280",
                  },
                  {
                    type: "text",
                    text: data.pid,
                    flex: 1,
                    align: "end",
                    size: "sm",
                    color: "#6b7280",
                  },
                ],
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "TID:",
                    flex: 0,
                    weight: "bold",
                    size: "sm",
                    color: "#6b7280",
                  },
                  {
                    type: "text",
                    text: data.tid,
                    flex: 1,
                    align: "end",
                    size: "sm",
                    color: "#6b7280",
                  },
                ],
              },
            ],
          },
        ],
        spacing: "lg",
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: {
              type: "uri",
              label: "View Transaction",
              uri: `${LIFF_URI}/transaction/${data.tid}`,
            },
            height: "sm",
          },
        ],
      },
      styles: {
        body: {
          separator: true,
        },
        footer: {
          separator: true,
        },
      },
      size: "kilo",
    },
  }),
};

// [Express]
const bot = express();
bot.use(cors({ origin: true }));

// [Middlewares]
// M - Check app secret.
const checkAppSecret = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (req.get("SECRET") === APP_SECRET) return next();
  else
    return next(
      new functions.https.HttpsError("permission-denied", "invalid credential.")
    );
};

// M - JSON parser
bot.use(express.json());

const extractUID = (input: string) => input.slice(5);
const extractUIDs = (inputs: Array<string>) =>
  inputs.map((uid) => uid.slice(5));

// M - UID extract.
bot.use((req: Request, res: Response, next: NextFunction) => {
  // Extract on target.
  if (req.body.target) req.body.target = extractUID(req.body.target as string);
  // Extract on targets.
  if (req.body.targets)
    req.body.targets = extractUIDs(req.body.targets as Array<string>);

  next();
});

// [Functions]
// -> Cars
// F - Push car notification.
bot.post("/car/:type", checkAppSecret, async (req: Request, res: Response) => {
  // Check type
  // CASE: invalid types.
  // DO: return not found.
  const { type } = req.params;
  if (!["add", "remove"].includes(type)) {
    throw new functions.https.HttpsError("not-found", "");
  }

  // Check required fields.
  // CASE: missing some fields.
  // DO: return invalid-arguments.
  if (!req.body.target || !req.body.license_number || !req.body.province) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "missing required fields."
    );
  }
  // Format data
  const target = req.body.target as string;
  const userId = `line:${target}`;
  const license_number = req.body.license_number as string;
  const data = {
    license_number: license_number,
    province: req.body.province as string,
  };

  // Push to customer.
  await LINE.pushMessage(target, Template.carNotification(type, data));

  // Record in cache.
  let car = cars.get<CarCustomers | null>(license_number) ?? null;
  switch (type) {
    case "add":
      if (car) car.owners.push(Firestore().collection("customers").doc(userId));
      else
        car = {
          license_number: license_number,
          owners: [Firestore().collection("customers").doc(userId)],
        };
      break;
    case "remove":
      if (car && car.owners.length > 1)
        car.owners = car.owners.filter((owner) => owner.id !== userId);
      else if (car && car.owners.length == 1) car = null;
    default:
      break;
  }
  cars.set<CarCustomers | null>(license_number, car);

  return res.status(200).send("OK");
});

// -> Transactions
// F - Push transaction notification.
bot.post(
  "/transaction/:type",
  checkAppSecret,
  async (req: Request, res: Response) => {
    // Check type
    // CASE: invalid types.
    // DO: return not found.
    const { type } = req.params;
    if (
      ![
        "entrance",
        "exit",
        "cancel",
        "overnight",
        "update",
        "warning",
      ].includes(type)
    ) {
      throw new functions.https.HttpsError("not-found", "");
    }

    // CASE: warning in-system transactions.
    if (type === "warning") {
      // CASE: missing targets.
      // DO: return invalid-arguments.
      if (!req.body.targets) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "missing targets."
        );
      }
      const targets = req.body.targets as Array<string>;
      targets.forEach(async (target) => {
        await LINE.pushMessage(target, Template.warningInSystemTransactions());
      });

      return res.status(200).send("OK.");
    }

    // Check required fields.
    // CASE: missing some fields.
    // DO: return invalid-arguments.
    if (!req.body.tid || !req.body.timestamp_in || !req.body.fee) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "missing required fields."
      );
    }

    // Check required fields on "exit"
    // CASE: missing some fields.
    // DO: return invalid-arguments.
    if (type === "exit" && !req.body.timestamp_out) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "missing required fields."
      );
    }

    // Format data.
    const license_number = req.body.license_number as string;
    if (!cars.has(license_number)) {
      const car_ref = await Firestore()
        .collection("cars")
        .doc(license_number)
        .get();
      const data = car_ref.exists ? (car_ref.data() as CarCustomers) : null;
      cars.set<CarCustomers | null>(license_number, data);
    }
    const car = cars.get<CarCustomers | null>(license_number) ?? null;
    if (!car) return res.status(200).send("OK.");

    // Multicast to customers.
    // CASE: has onwer.
    // DO: call multicast.
    if (car.owners.length > 0) {
      const data = {
        tid: req.body.tid as string,
        license_number: license_number,
        timestamp_in: req.body.timestamp_in as string,
        timestamp_out: req.body.timestamp_out as string | undefined,
        fee: req.body.fee as number,
        image_in: req.body.image_in as string | undefined,
        image_out: req.body.image_out as string | undefined,
      };
      car.owners.forEach(async (target) => {
        await LINE.pushMessage(
          extractUID(target.id),
          Template.transactionNotification(type, data)
        );
      });
    }

    // Return
    return res.status(200).send("OK.");
  }
);

// -> Payments
// F - Push payment notification.
bot.post(
  "/payment/:type",
  checkAppSecret,
  async (req: Request, res: Response) => {
    // Check type
    // CASE: invalid types.
    // DO: return not found.
    const { type } = req.params;
    if (!["receive", "reject", "refund"].includes(type)) {
      throw new functions.https.HttpsError("not-found", "");
    }

    // Check required fields.
    // CASE: missing required fields.
    // DO: retrun invalid-arguments
    if (
      !req.body.target ||
      !req.body.amount ||
      !req.body.timestamp ||
      !req.body.pid ||
      !req.body.tid
    ) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "missing required fields."
      );
    }

    // Format data.
    const target = req.body.target as string;
    const data = {
      amount: req.body.amount as number,
      timestamp: req.body.timestamp as string,
      pid: req.body.pid as string,
      tid: req.body.tid as string,
    };

    // Push to customer.
    LINE.pushMessage(target, Template.paymentNotification(type, data));

    // Return
    return res.status(200).send("OK.");
  }
);

// [Error handler]
bot.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (typeof err === "undefined") {
    if (!res.headersSent) res.status(200).send("done.");
    return;
  } else if (err instanceof line.SignatureValidationFailed) {
    return res.status(401).send(err.signature);
  } else if (err instanceof line.JSONParseError) {
    return res.status(400).send(err.raw);
  } else if (err instanceof line.ReadError) {
    console.error(err.message);
    return res.status(500).send(err.message);
  } else if (err instanceof line.RequestError) {
    console.error(err.message);
    return res.status(500).send(err.message);
  } else if (err instanceof line.HTTPError) {
    console.error(err.originalError);
    return res.status(500).send(err.message);
  } else if (err instanceof functions.https.HttpsError) {
    console.error(err.message);
    return res.status(err.httpErrorCode.status).send(err.message);
  }
  console.error(err.stack);
  return res.status(500).send(err.message ? err.message : "no message");
});

module.exports = functions
  .region("asia-southeast2")
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(bot);
