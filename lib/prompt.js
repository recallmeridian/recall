'use strict';

const readline = require('readline');

/**
 * prompt(question) — Ask a single question and return the trimmed answer.
 */
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * choose(question, choices) — Show a numbered list and return the chosen value.
 * choices: string[]
 */
async function choose(question, choices) {
  console.log(question);
  choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  while (true) {
    const answer = await prompt('Enter number: ');
    const n = parseInt(answer, 10);
    if (n >= 1 && n <= choices.length) return choices[n - 1];
    console.log(`  Please enter a number between 1 and ${choices.length}.`);
  }
}

async function confirm(question, defaultValue = false) {
  const suffix = defaultValue ? ' [Y/n]: ' : ' [y/N]: ';
  const answer = (await prompt(question + suffix)).toLowerCase();
  if (!answer) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

module.exports = { prompt, choose, confirm };
