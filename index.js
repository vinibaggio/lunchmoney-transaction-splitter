const fetch = require("node-fetch");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const argv = yargs(hideBin(process.argv)).argv;

require("dotenv").config();

let baseUrl = "https://dev.lunchmoney.app";
let token = process.env.LUNCH_MONEY_APP_KEY;

let headers = { authorization: `Bearer ${token}` };

let txnsUrl = `${baseUrl}/v1/transactions`;
let categoriesUrl = `${baseUrl}/v1/categories`;
let txnUpdateUrl = `${baseUrl}/v1/transactions/`;

const monthToRun = argv.month || new Date().getMonth() + 1;
const yearToRun = argv.year || new Date().getFullYear();

const firstDay = new Date(yearToRun, monthToRun - 1, 1);
const lastDay = new Date(yearToRun, monthToRun, 0);

async function findReimbursementsCategory() {
  let categories = await fetch(categoriesUrl, { headers }).then((resp) =>
    resp.json()
  );

  const reimburse = categories.categories.find(
    (c) => c.name.toLowerCase() == "reimbursements"
  );

  return reimburse.id;
}

async function putTransaction(transactionId, body) {
  let resp = await fetch(`${txnUpdateUrl}${transactionId}`, {
    headers: {
      ...headers,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "PUT",
    body: JSON.stringify(body),
  }).then((r) => r.json());

  return resp;
}

async function markReimbursed(transaction) {
  return await putTransaction(transaction.id, { transaction: { tags: [] } });
}

async function splitTransaction(transaction, reimbursementCategoryId) {
  let centAmount = Math.round(parseFloat(transaction.amount, 10) * 100);
  let divided = Math.floor(centAmount / 2);
  let rest = centAmount % 2 == 0 ? 0 : 1;
  let amount1 = (divided + rest) / 100;
  let amount2 = divided / 100;

  //   console.log({
  //     origAmount: transaction.amount,
  //     centAmount,
  //     divided,
  //     rest,
  //     amount1,
  //     amount2,
  //   });

  let updateObject = {
    split: [
      {
        category_id: transaction.category_id,
        amount: amount1,
      },
      {
        category_id: reimbursementCategoryId,
        amount: amount2,
      },
    ],
  };

  let splitResp;
  try {
    splitResp = await putTransaction(transaction.id, updateObject);
  } catch (e) {
    console.log(splitResp, e);
    throw e;
  }

  for (let splitId of splitResp.split) {
    await putTransaction(splitId, {
      transaction: { tags: ["Split"] },
    });
  }
}

function filterByTag(txs, tag) {
  return txs.filter((tx) =>
    tx.tags
      .map((t) => {
        return t.name.toLowerCase();
      })
      .includes(tag.toLowerCase())
  );
}

async function main() {
  console.log(
    `Running transactions for ${
      firstDay.getMonth() + 1
    }/${firstDay.getFullYear()}`
  );

  let reimbursementCategoryId = await findReimbursementsCategory();

  let toStr = (s) => s.toJSON().split("T")[0];
  let txnFullUrl =
    txnsUrl + "?start_date=" + toStr(firstDay) + "&end_date=" + toStr(lastDay);

  let txns = await fetch(txnFullUrl, {
    headers,
  }).then((resp) => resp.json());
  //   console.log(txns);

  let tagged = txns.transactions.filter((tx) => tx.tags?.length > 0);
  let toSplit = filterByTag(tagged, "split").filter(
    (tx) => tx.parent_id == null
  );
  let toReimburse = filterByTag(tagged, "reimburse");

  console.log(
    `To split: ${toSplit.length}\nTo reimburse: ${toReimburse.length}`
  );

  for (let txnToSplit of toSplit) {
    console.log(
      `> Splitting transaction ${txnToSplit.payee}, ${txnToSplit.amount} (TOTAL) – ${txnToSplit.original_name}`
    );
    await splitTransaction(txnToSplit, reimbursementCategoryId);
  }

  for (let txnToReimburse of toReimburse) {
    console.log(
      `> Reimburse transaction ${txnToReimburse.payee}, ${txnToReimburse.amount} (TOTAL) – ${txnToReimburse.original_name}`
    );
    await markReimbursed(txnToReimburse);
  }

  //   console.log(toSplit);
}

main()
  .catch((err) => console.error(err))
  .finally(() => console.log("Done!"));
