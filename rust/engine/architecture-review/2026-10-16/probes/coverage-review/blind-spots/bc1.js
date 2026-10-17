function Ctor(a){this.a=a} var BC = Ctor.bind(null,"q"); throw new Error(String(new BC().a));
