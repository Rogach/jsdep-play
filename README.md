jsdep-play
==========

Example Play! Framework project which showcases automatic dependency import for Angular & RequireJS projects. Described here: [Solving quadruple dependency injection problem](http://blog.rogach.org/2016/02/solving-quadruple-dependency-injection.html).

I failed to find a way to add preprocessing to javascript files while still keeping sources in standard app/assets directory, thus javascript sources here are located in app/cilent directory and are compiled with preprocessor and injected into assets pipeline. As an unfortunate side effect, some plugins break - for example, in this template I had to place js-hint directly inside preprocessor, since standard plugin is coupled to app/assets directory.

Usage
-----

jsdep script requires Node.js being present and runnable and depends on several Node.js libraries, which you can install by running `npm install` in root directory. After that, simple `sbt run` should start Play! server as usual.
