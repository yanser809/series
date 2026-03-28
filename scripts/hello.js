// hello.js – simple self-test script for /run
// Usage (from Telegram): /run hello.js
// Usage (CLI): node scripts/hello.js [name]

const name = process.argv[2] ?? "mundo";
console.log(`Hola, ${name}!`);
console.log(`Node.js ${process.version}`);
console.log(`Fecha: ${new Date().toISOString()}`);
