class MyErr extends Error {}; MyErr.prototype.name = "MyErr"; throw new MyErr("m");
