#!/usr/bin/env node
/**
 * Export the wallets persisted in runs/state.json to MetaMask-importable
 * formats.
 *
 * Default: one encrypted JSON keystore (V3) per wallet, written to
 * runs/keystore/ (gitignored). Import in MetaMask with
 * "Import account" -> "JSON file" and the password used here.
 *
 * Usage:
 *   node scripts/agent-city/export-keys.mjs                 # all roles, asks password
 *   node scripts/agent-city/export-keys.mjs --roles owner,team0
 *   node scripts/agent-city/export-keys.mjs --out /secure/dir
 *   node scripts/agent-city/export-keys.mjs --plain         # print raw keys to stdout only
 *
 * The password can also come from the EXPORT_PASSWORD env var. Raw keys are
 * never written to disk; --plain prints them to stdout for direct paste into
 * MetaMask ("Import account" -> "Private key").
 */

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const STATE_FILE = process.env.STATE_FILE || path.join("runs", "state.json");
const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const PLAIN = args.includes("--plain");
const OUT_DIR = getArg("--out") || path.join("runs", "keystore");
const ROLES_ALL = ["owner", "provider", "team0", "team1", "team2", "team3", "team4", "voter0", "voter1", "voter2"];
const roles = getArg("--roles") ? getArg("--roles").split(",").map((r) => r.trim()) : ROLES_ALL;

const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (ch) => {
      if (["\n", "\r", ""].includes(ch.toString())) process.stdout.write("\n");
      else readline.moveCursor(process.stdout, -1, 0), process.stdout.write("*");
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.off("data", onData);
      rl.close();
      resolve(answer);
    });
  });
}

const wallets = roles
  .filter((r) => state[r]?.privateKey)
  .map((r) => ({ role: r, wallet: new ethers.Wallet(state[r].privateKey) }));

if (wallets.length === 0) {
  console.error(`No wallets found in ${STATE_FILE} for roles: ${roles.join(", ")}`);
  process.exit(1);
}

if (PLAIN) {
  console.log("role\taddress\tprivate_key");
  for (const { role, wallet } of wallets) console.log(`${role}\t${wallet.address}\t${wallet.privateKey}`);
  console.error("\n(Claves en crudo solo por stdout; no se ha escrito nada a disco.)");
  process.exit(0);
}

let password = getArg("--password") || process.env.EXPORT_PASSWORD;
if (!password) {
  password = await askHidden("Contraseña para cifrar los keystores: ");
  const confirm = await askHidden("Repite la contraseña: ");
  if (password !== confirm) {
    console.error("Las contraseñas no coinciden.");
    process.exit(1);
  }
}
if (!password || password.length < 8) {
  console.error("Usa una contraseña de al menos 8 caracteres.");
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const { role, wallet } of wallets) {
  const json = await wallet.encrypt(password);
  const file = path.join(OUT_DIR, `keystore-${role}-${wallet.address}.json`);
  fs.writeFileSync(file, json, { mode: 0o600 });
  // round-trip check: the keystore must decrypt back to the same address
  const back = await ethers.Wallet.fromEncryptedJson(json, password);
  if (back.address !== wallet.address) throw new Error(`round-trip mismatch for ${role}`);
  console.log(`${role}: ${file} (verificado)`);
}

console.log(`
${wallets.length} keystores V3 escritos en ${OUT_DIR}/ (permisos 600, fuera de git).

Importar en MetaMask:
  1. Añade la red NETX Testnet: RPC https://testnetrpc.netxscan.io,
     chain id 587, símbolo tNETX, explorador https://testnet.netxscan.io
  2. Cuentas -> "Importar cuenta" -> tipo "Archivo JSON" -> selecciona el
     keystore y usa la contraseña de cifrado.
`);
