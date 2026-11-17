var a = 2147483647|0; a++; var b = (1<<31); b += -1; var c = (1<<31); c = c - 1; throw new Error(String([a,b,c]));
