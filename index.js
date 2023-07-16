const fetch = require("node-fetch");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const argv = yargs(hideBin(process.argv)).argv;
const prompt = require("prompt-sync")({ sigint: true });

require("dotenv").config();

const baseUrl = "https://dev.lunchmoney.app/v1";
const token = process.env.LUNCH_MONEY_APP_KEY;
const lunchMoneyHeaders = { authorization: `Bearer ${token}` };
const txnsUrl = `${baseUrl}/transactions`;
const categoriesUrl = `${baseUrl}/categories`;
const txnUpdateUrl = `${baseUrl}/transactions/`;

const splitwiseGroupId = process.env.SPLITWISE_GROUP_ID;
const splitwiseBaseUrl = "https://secure.splitwise.com/api/v3.0";
const splitwiseToken = process.env.SPLITWISE_API_KEY;
const splitwiseHeaders = { authorization: `Bearer ${splitwiseToken}` };
const splitwiseCreateExpense = `${splitwiseBaseUrl}/create_expense`;
const splitwiseGetSelf = `${splitwiseBaseUrl}/get_current_user`;
const splitwiseGetGroupInfo = `${splitwiseBaseUrl}/get_group/${splitwiseGroupId}`;

const dryRun = argv.dryRun != "false";
const confirm = argv.confirm == "true";
const monthToRun = argv.month || new Date().getMonth() + 1;
const yearToRun = argv.year || new Date().getFullYear();

const firstDay = new Date(yearToRun, monthToRun - 1, 1);
const lastDay = new Date(yearToRun, monthToRun, 0);

async function findReimbursementsCategory() {
  let categories = await fetch(categoriesUrl, {
    headers: lunchMoneyHeaders,
  }).then((resp) => resp.json());

  const reimburse = categories.categories.find(
    (c) => c.name.toLowerCase() == "reimbursements"
  );

  return reimburse.id;
}

async function getSwData() {
  let selfResp = await fetch(splitwiseGetSelf, {
    headers: {
      ...splitwiseHeaders,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "GET",
  });
  let selfJson = await selfResp.json();
  let myId = selfJson.user.id;

  let groupResp = await fetch(splitwiseGetGroupInfo, {
    headers: {
      ...splitwiseHeaders,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "GET",
  });

  let groupJson = await groupResp.json();
  let partnerId = groupJson.group.members.find((m) => m.id != myId);
  return [myId, partnerId];
}

async function putTransaction(transactionId, body) {
  let resp = await fetch(`${txnUpdateUrl}${transactionId}`, {
    headers: {
      ...lunchMoneyHeaders,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "PUT",
    body: JSON.stringify(body),
  }).then((r) => r.json());

  return resp;
}

async function markReimbursed(transaction) {
  if (dryRun) {
    console.log(`Would have marked reimbursed`, transaction);
    return;
  }
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
    if (dryRun) {
      console.log(`Would have marked split`);
      return;
    }
    splitResp = await putTransaction(transaction.id, updateObject);
  } catch (e) {
    console.log(splitResp, e);
    throw e;
  }

  if (splitResp.error) {
    console.log(splitResp);
    return false;
  }

  for (let splitId of splitResp.split) {
    if (dryRun) {
      console.log(`Would have marked split`, { transaction });
      return false;
    }
    await putTransaction(splitId, {
      transaction: { tags: ["Split"] },
    });
  }

  return true
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

async function logInSplitwise(swData, transaction, toSplit) {
  let options = {
    description: transaction.notes ?? transaction.payee,
    group_id: splitwiseGroupId,
    cost: transaction.amount,
  };

  let [myId, partnerId] = [swData];

  if (toSplit) {
    options = { ...options, split_equally: true };
  } else {
    options = {
      users__0__user_id: myId,
      users__0__paid_share: transaction.amount,
      users__0__owed_share: 0,
      users__1__user_id: partnerId,
      users__1__paid_share: 0,
      users__1__owed_share: transaction.amount,
    };
  }

  if (dryRun) {
    console.log("Would have logged into splitwise", { options });
  } else {
    let resp = await fetch(splitwiseCreateExpense, {
      headers: {
        ...splitwiseHeaders,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify(options),
    }).then((r) => r.json());
    // console.log({ expenses: resp.expenses });
  }
}

async function main() {
  console.log(
    `Running transactions for ${
      firstDay.getMonth() + 1
    }/${firstDay.getFullYear()}`
  );

  let swData = await getSwData();

  let reimbursementCategoryId = await findReimbursementsCategory();

  let toStr = (s) => s.toJSON().split("T")[0];
  let txnFullUrl =
    txnsUrl + "?start_date=" + toStr(firstDay) + "&end_date=" + toStr(lastDay);

  let txns = await fetch(txnFullUrl, {
    headers: lunchMoneyHeaders,
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
    if (confirm) {
      prompt("Confirm? ");
    }
    let didSplit = await splitTransaction(txnToSplit, reimbursementCategoryId);
    if (didSplit) {
      await logInSplitwise(swData, txnToSplit, true);
    }
  }

  for (let txnToReimburse of toReimburse) {
    console.log(
      `> Reimburse transaction ${txnToReimburse.payee}, ${txnToReimburse.amount} (TOTAL) – ${txnToReimburse.original_name}`
    );
    if (confirm) {
      prompt("Confirm? ");
    }
    await logInSplitwise(swData, txnToReimburse, false);
    await markReimbursed(txnToReimburse);
  }

  //   console.log(toSplit);
}

main()
  .catch((err) => console.error(err))
  .finally(() => console.log("Done!"));
