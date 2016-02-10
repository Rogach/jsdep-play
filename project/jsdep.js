sourceDir = process.argv[2];
targetDir = process.argv[3];
sourceMapPrefix = process.argv[4] || "";

var fs = require("fs-extra");
var fsPath = require("path");
var assert = require("assert");
var _ = require("underscore");
var jshint = require("jshint");
var recast = require("recast");
var n = recast.types.namedTypes;
var b = recast.types.builders;

function listFilesRecursively(path) {
  if (fs.lstatSync(path).isDirectory()) {
    return fs.readdirSync(path).map(function(child) {
      return listFilesRecursively(fsPath.join(path, child));
    }).reduce(function(a,b) { return a.concat(b); });
  } else {
    return [path];
  }
}
function mkdirp(path) {
  try {
    fs.lstatSync(path);
  } catch (e) {
    mkdirp(fsPath.dirname(path));
    fs.mkdirSync(path);
  }
}

var inputs = listFilesRecursively(sourceDir);

var dependencyNames = {};
var params = {};
var modules = {};
var symbols = {};

var configFiles = _.filter(inputs, function(path) { return /\.provided.json$/.test(path); });
var javascriptFiles = _.filter(inputs, function(path) { return /\.js$/.test(path); });

// load config files
configFiles.forEach(function(file) {
  var configs = JSON.parse(fs.readFileSync(file, { encoding: "UTF-8" }));
  assert(_.isObject(configs));
  _.each(configs, function(config, name) {
    if (config.dependency) {
      dependencyNames[config.dependency] = name.replace(/-/g, "_");
    }
    if (config.symbol) {
      symbols[config.symbol] = {
        dependency: config.dependency
      };
    }
    if (config.modules) {
      _.each(config.modules, function(module) {
        modules[module] = {
          dependency: name
        };
      });
    }
    if (config.params) {
      _.each(config.params, function(param) {
        params[param] = {
          dependency: name
        };
        if (config.modules) {
          params[param].modules = config.modules;
        }
      });
    }
  });
});

// load all the files
var files = _.map(javascriptFiles, function(file) {
  var basePath = fsPath.relative(sourceDir, file);
  var rjsPath = basePath.replace(/\.js$/, "");
  var origPath = rjsPath + ".orig.js";
  var txt = fs.readFileSync(file, { encoding: "UTF-8" });

  jshint.JSHINT(txt, {});
  jshint.JSHINT.errors.forEach(function(error) {
    console.error(
      "%s(%d,%d): %s",
      fsPath.join(file),
      error.line,
      error.character,
      error.reason
    );
  });

  return {
    ast: recast.parse(txt, { sourceFileName: fsPath.join(sourceMapPrefix, origPath) }),
    basePath: basePath,
    origText: txt,
    outputFile: basePath,
    origFile: origPath,
    mapFile: basePath + ".map.json",
    rjsPath: rjsPath
  }
});

var definePredicate = function(value) {
  return n.Identifier.check(value.callee) &&
    value.callee.name == "define" &&
    n.ArrayExpression.check(value.arguments[0]) &&
    _.every(value.arguments[0].elements, function(e) {
      return n.Literal.check(e);
    });
};

var angularModulePredicate = function(value) {
  return n.MemberExpression.check(value.callee) &&
    n.Identifier.check(value.callee.object) &&
    value.callee.object.name == "angular" &&
    n.Identifier.check(value.callee.property) &&
    value.callee.property.name == "module" &&
    n.Literal.check(value.arguments[0]);
};

// read in all dependency information
files.forEach(function(file) {
  file.dependencies = [];
  file.angularDependencies = [];

  // read requirejs dependencies for this source file
  recast.types.visit(file.ast, {
    visitCallExpression: function(path) {
      if (definePredicate(path.value)) {
        file.dependencies = _.map(path.value.arguments[0].elements, function(e) {
          return e.value;
        });
      }
      return false;
    }
  });

  // locate dependable identifiers
  recast.types.visit(file.ast, {
    visitIdentifier: function(path) {
      var sym = symbols[path.value.name];
      if (sym && sym.dependency) {
        file.dependencies.push(sym.dependency);
      }
      this.traverse(path);
    }
  });

  // read angular module name
  recast.types.visit(file.ast, {
    visitCallExpression: function(path) {
      if (angularModulePredicate(path.value)) {
        file.moduleName = path.value.arguments[0].value;
        if (n.ArrayExpression.check(path.value.arguments[1]) &&
            _.every(path.value.arguments[1].elements, function(e) {
              return n.Literal.check(e);
            })
           ) {
          file.angularDependencies = _.map(path.value.arguments[1].elements, function(e) {
            return e.value;
          });
        }
        modules[file.moduleName] = {
          dependency: file.rjsPath
        };
        return false;
      } else {
        this.traverse(path);
      }
    }
  });

  // detect angular values/factories/services/etc
  recast.types.visit(file.ast, {
    visitCallExpression: function(path) {
      if (n.MemberExpression.check(path.value.callee) &&
          n.Identifier.check(path.value.callee.property) &&
          n.Literal.check(path.value.arguments[0])
         ) {
        var providerType = path.value.callee.property.name;
        var providerName = path.value.arguments[0].value;
        if (providerType == "value" ||
            providerType == "constant" ||
            providerType == "factory" ||
            providerType == "service"
           ) {
          params[providerName] = {
            dependency: file.rjsPath,
            module: file.moduleName
          }
        } else if (providerType == "provider") {
          params[providerName + "Provider"] = {
            dependency: file.rjsPath,
            module: file.moduleName
          }
        }
      }
      this.traverse(path);
    }
  });

});

// apply transformations
files.forEach(function(file) {
  // if file contents are not wrapped in define(), wrap them here
  if ((!n.ExpressionStatement.check(file.ast.program.body[0]) ||
       !definePredicate(file.ast.program.body[0].expression)) &&
      !/requirejs.config/.test(file.origText)
  ) {
    file.ast.program.body = [b.expressionStatement(
      b.callExpression(
        b.identifier("define"),
        [
          b.arrayExpression([]),
          b.functionExpression(null, [], b.blockStatement(file.ast.program.body))
        ]
      )
    )];
  }

  // find and wrap injectable functions
  recast.types.visit(file.ast, {
    visitObjectExpression: function(path) {
      var resolveKeyValue = _.find(path.value.properties, function(kv) {
        return n.Identifier.check(kv.key) &&
          kv.key.name == "resolve" &&
          n.ObjectExpression.check(kv.value);
      });
      if (resolveKeyValue) {
        _.each(resolveKeyValue.value.properties, function(prop) {
          params[prop.key.name] = {};
        });
        this.traverse(path);
        _.each(resolveKeyValue.value.properties, function(prop) {
          delete params[prop.key.name];
        });
      } else {
        this.traverse(path);
      }
    },
    visitFunctionExpression: function(path) {
      this.traverse(path);
      if (path.value.params.length > 0 &&
          _.every(path.value.params, function(param) {
            return params[param.name];
          }) &&
          // do not wrap if it is already wrapped
          !n.ArrayExpression.check(path.parentPath.parentPath.value)
         ) {

        var wrapper = [];
        _.each(path.value.params, function(param) {
          var p = params[param.name];
          wrapper.push(b.literal(param.name));
          _.each(p.modules, function(module) {
            file.angularDependencies.push(module);
          });
          if (p.dependency) {
            file.dependencies.push(p.dependency);
          }
          if (p.module) {
            file.angularDependencies.push(p.module);
          }
        });
        wrapper.push(path.value);
        path.replace(b.arrayExpression(wrapper));
      }
    }
  });

  // add requirejs dependencies for angular modules
  _.each(file.angularDependencies, function(module) {
    if (modules[module] && modules[module].dependency) {
      file.dependencies.push(modules[module].dependency);
    }
  });

  // set angular dependencies in this source file
  recast.types.visit(file.ast, {
    visitCallExpression: function(path) {
      if (angularModulePredicate(path.value)) {
        var modulesExpr = b.arrayExpression(
          _.map(_.uniq(file.angularDependencies), function(dep) {
            return b.literal(dep);
          })
        );
        if (path.value.arguments.length == 1) {
          path.get("arguments").push(modulesExpr);
        } else {
          path.get("arguments", 1).replace(modulesExpr);
        }
        return false;
      } else {
        this.traverse(path);
      }
    }
  });


  // set requirejs dependencies in this source file
  recast.types.visit(file.ast, {
    visitCallExpression: function(path) {
      if (definePredicate(path.value)) {
        var defaultDependencyNames = {};
        _.each(_.zip(path.value.arguments[0].elements, path.value.arguments[1].params), function(depName) {
          if (depName[0] && depName[1]) {
            defaultDependencyNames[depName[0].value] = depName[1].name;
          }
        });

        var dependencies = _.uniq(file.dependencies);
        path.get("arguments", 0).replace(
          b.arrayExpression(_.map(dependencies, function(dep) {
            return b.literal(dep);
          }))
        );
        path.get("arguments", 1, "params").replace(_.map(dependencies, function(dep) {
          return b.identifier(defaultDependencyNames[dep] || dependencyNames[dep] || "___");
        }));
      }
      return false;
    }
  });

});

// output resulting files
files.forEach(function(file) {
  var processed = recast.print(file.ast, { sourceMapName: fsPath.join(sourceMapPrefix, file.mapFile) });
  var sourceMapComment = "\n//# sourceMappingURL=" + fsPath.join(sourceMapPrefix, file.mapFile) + "\n";

  mkdirp(fsPath.dirname(fsPath.join(targetDir, file.outputFile)));

  var outputFile = fsPath.join(targetDir, file.outputFile)
  fs.writeFileSync(outputFile, processed.code + sourceMapComment, { encoding: "UTF-8" });
  console.log(outputFile);

  var origFile = fsPath.join(targetDir, file.origFile)
  fs.writeFileSync(origFile, file.origText, { encoding: "UTF-8" });
  console.log(origFile);

  var mapFile = fsPath.join(targetDir, file.mapFile);
  fs.writeFileSync(mapFile, JSON.stringify(processed.map), { encoding: "UTF-8" });
  console.log(mapFile);
});
