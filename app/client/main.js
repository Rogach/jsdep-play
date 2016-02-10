(function(requirejs) {
  "use strict";
  requirejs.config({
    paths: {
      "angular": "lib/angularjs/angular"
    },
    shim: {
      "angular": { exports : "angular" },
    }
  });

  require([
    "angular",
    "show.answer"
  ], function(angular) {

    angular.bootstrap(document, [ "show.answer" ]);
  });
})(requirejs);
