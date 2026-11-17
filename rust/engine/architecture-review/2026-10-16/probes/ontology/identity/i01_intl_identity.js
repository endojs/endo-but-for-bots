var r = [Intl.__ironhorseDataVersion,
  new Intl.NumberFormat("en", { notation: "compact" }).format(12345),
  JSON.stringify(new Date(0))];
throw new Error(JSON.stringify(r));
