(function () {
        var p = location.pathname;
        var pub = ["/rental-request", "/rental-status", "/checkout", "/portal"].some(function (x) {
          return p === x || p.indexOf(x + "/") === 0;
        });
        document.documentElement.dataset.surface = pub ? "public" : "admin";
      })();
