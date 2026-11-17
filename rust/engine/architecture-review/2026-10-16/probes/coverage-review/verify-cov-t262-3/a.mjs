function fn(x){return class {};}
export class C extends fn(await 1) {};
