#!/usr/bin/env node
// Stands in for /usr/bin/osascript: records its arguments and plays a scenario named in the input.
const args = process.argv.slice(2);
const input = JSON.parse(args[args.length - 1] ?? "{}");
const scenario = input.scenario ?? "echo";
if (scenario === "echo") process.stdout.write(JSON.stringify({ args }));
else if (scenario === "denied") { process.stderr.write("execution error: Error: Not authorized to send Apple events to Notes. (-1743)\n"); process.exit(1); }
else if (scenario === "missing") { process.stderr.write("execution error: Error: Can't get object. (-1728)\n"); process.exit(1); }
else if (scenario === "hang") setTimeout(() => {}, 60_000);
else if (scenario === "garbage") process.stdout.write("not json");
